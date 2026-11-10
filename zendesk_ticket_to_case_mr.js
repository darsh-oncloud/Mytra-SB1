/**
 * @NApiVersion 2.1
 * @NScriptType MapReduceScript
 * @NModuleScope SameAccount
 *
 * Zendesk Ticket -> NetSuite Field Service Case  (CREATE ONLY)
 *
 * For each Zendesk ticket:
 *   1. ASSET     ticket asset fields (Bot Asset / Assets / Asset) hold Zendesk asset IDs
 *                -> NetSuite Field Service Asset whose custrecord_asset_id = that ID
 *   2. CUSTOMER  first match of: ticket organization -> Customer Site field -> requester's org
 *                -> NetSuite Customer whose custentity_organization_id = that org ID
 *                fallback: the asset's Customer
 *   3. CASE      created on form 417 "Field Service Case" (externalid = ZD-<ticket id>)
 *   Missing asset/customer -> skipped, reason counted in SKIP REASONS.
 *   Tickets that already have a case (externalid ZD-<id>) are skipped.
 *
 * TEST:  TEST_ALL_TICKETS = true   -> every ticket in Zendesk
 * LIVE:  TEST_ALL_TICKETS = false  -> tickets created in the last LOOKBACK_HOURS
 * One ticket: TEST_TICKET_ID = '123'
 *
 * No script parameters: set everything below.
 */
define(['N/https', 'N/record', 'N/search', 'N/log'],
function (https, record, search, log) {

    // =====================================================
    // CONFIG - ZENDESK
    // =====================================================
    var ZD = {
        BASE_URL: 'https://mytra.zendesk.com',
        CLIENT_ID: 'netsuite_fsm_integration',
        CLIENT_SECRET: '4f1beaf8b4a16f576d75f7bc4d8e77d63ac1d07a23d6f4293036c4fe62ef5779',
        SCOPE: 'read',

        // Ticket fields (IDs from the ticket discovery)
        ASSET_FIELD_IDS: [55275377111956, 54364777978132, 47189268307348], // Bot Asset, Assets, Asset
        CUSTOMER_SITE_FIELD_ID: 36818231414036,                            // Customer Site (org lookup)
        SERVICE_ORDER_TYPE_FIELD_ID: 54049604285972                        // Service Order Type
    };

    var TEST_ALL_TICKETS = true;   // true = all tickets (testing), false = new tickets only
    var LOOKBACK_HOURS = 24;       // live mode window
    var TEST_TICKET_ID = '';       // one ticket only, e.g. '1234'
    var REQUIRE_ASSET = true;      // false = create the case with the customer only

    // =====================================================
    // CONFIG - NETSUITE
    // =====================================================
    var CUST_ZD_ORG_FIELD = 'custentity_organization_id';
    var ASSET_RECORD_TYPE = 'customrecord_nx_asset';
    var ASSET_ZD_ID_FIELD = 'custrecord_asset_id';
    var ASSET_CUSTOMER_FIELD = 'custrecord_nx_asset_customer';

    var CASE = {
        FORM_ID: '417',                               // Field Service Case
        // Case field IDs - VERIFY with Field Help on the case form ('' = not set)
        F_CASE_TYPE:   'custevent_nx_case_type',      // confirmed
        F_ASSET:       'custevent_nx_case_asset',     // VERIFY
        F_CASE_ASSETS: 'custevent_nx_case_assets',    // VERIFY (multiselect)
        F_PROJECT:     'custevent_nx_case_project',   // VERIFY
        F_ASSIGNED:    'assigned',
        F_EMAIL:       'email',
        F_ZD_TICKET:   '',                            // optional custom field for the ticket ID

        // Project: fixed ID, or '' = first open project of the customer
        PROJECT_ID: '',
        // Assigned: Zendesk assignee email -> NetSuite employee email, else this employee
        DEFAULT_ASSIGNED: '10',                       // Dhruv Soni - change as needed

        // Case Type (custevent_nx_case_type): 5 Install, 6 Maintenance, 7 Repair, 8 Uninstall
        CASE_TYPE: {
            'fsm_preventative': '6',
            'fsm_corrective':   '7',
            'fsm_recovery':     '7',
            'fsm_retrofit':     '5'
        },
        DEFAULT_CASE_TYPE: '6',                       // Maintenance

        // Zendesk value -> NetSuite internal ID (Setup > Support > Case Statuses / Priorities)
        STATUS: { 'new': '1', 'open': '2', 'pending': '2', 'hold': '2', 'solved': '5', 'closed': '5' },
        PRIORITY: { 'urgent': '1', 'high': '1', 'normal': '2', 'low': '3' },
        DEFAULT_STATUS: '1',
        DEFAULT_PRIORITY: '2'
    };

    // =====================================================
    // HELPERS
    // =====================================================
    function parse(b) { try { return JSON.parse(b); } catch (e) { return { raw: b }; } }

    function getToken() {
        var s = ZD.CLIENT_SECRET;
        if (!s || s.indexOf('PASTE_') === 0) throw Error('Set ZD.CLIENT_SECRET at the top of the script');
        var res = https.post({
            url: ZD.BASE_URL + '/oauth/tokens',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({ grant_type: 'client_credentials', client_id: ZD.CLIENT_ID,
                                   client_secret: s, scope: ZD.SCOPE })
        });
        var d = parse(res.body);
        if (Number(res.code) !== 200 || !d.access_token) throw Error('Zendesk OAuth failed: ' + res.code + ' ' + res.body);
        return d.access_token;
    }

    function zget(tok, urlOrPath) {
        var url = urlOrPath.indexOf('http') === 0 ? urlOrPath : ZD.BASE_URL + urlOrPath;
        var res = https.get({ url: url, headers: { Authorization: 'Bearer ' + tok, Accept: 'application/json' } });
        var d = parse(res.body);
        if (Number(res.code) !== 200) {
            log.error('Zendesk GET ' + urlOrPath, { httpCode: res.code, response: d });
            throw Error('Zendesk GET failed: HTTP ' + res.code);
        }
        return d;
    }

    function cfValue(ticket, fieldId) {
        var out = null;
        (ticket.custom_fields || []).forEach(function (c) { if (Number(c.id) === Number(fieldId)) out = c.value; });
        return out;
    }

    function ticketAssetIds(ticket) {
        var out = [];
        ZD.ASSET_FIELD_IDS.forEach(function (fid) {
            var v = cfValue(ticket, fid);
            if (v == null || v === '') return;
            (Array.isArray(v) ? v : [v]).forEach(function (x) { if (x && out.indexOf(String(x)) < 0) out.push(String(x)); });
        });
        return out;
    }

    // Zendesk users (requester / assignee) -> { id: { email, orgId } }, 100 per call
    function loadUsers(tok, ids) {
        var users = {};
        for (var i = 0; i < ids.length; i += 100) {
            var d = zget(tok, '/api/v2/users/show_many.json?ids=' + ids.slice(i, i + 100).join(','));
            (d.users || []).forEach(function (u) {
                users[u.id] = { email: u.email || '', orgId: u.organization_id ? String(u.organization_id) : '' };
            });
        }
        return users;
    }

    function existingCaseIds() {
        var ids = {};
        search.create({
            type: search.Type.SUPPORT_CASE,
            filters: [['externalidstring', 'startswith', 'ZD-']],
            columns: ['externalid']
        }).run().each(function (r) { ids[String(r.getValue('externalid'))] = true; return true; });
        return ids;
    }

    function findOne(type, filters) {
        var id = '';
        search.create({ type: type, filters: filters, columns: ['internalid'] })
            .run().each(function (r) { id = r.id; return false; });
        return id;
    }

    function trySet(rec, fieldId, value, what, ticketId) {
        if (!fieldId || value === '' || value == null) return;
        try { rec.setValue({ fieldId: fieldId, value: value }); }
        catch (e) { log.error('Ticket ' + ticketId + ': could not set ' + what + ' (' + fieldId + ')', e.message); }
    }

    // Skips are counted per reason; only the first few are logged one by one.
    var SKIP_LOG_LIMIT = 20, skipLogged = 0;
    function skip(context, ticketId, reason) {
        if (skipLogged++ < SKIP_LOG_LIMIT) log.audit('SKIPPED ticket ' + ticketId, reason);
        context.write({ key: 'skipped', value: 1 });
        context.write({ key: 'reason: ' + reason.replace(/[0-9A-Z]{20,}|\d{6,}/g, '#'), value: 1 });
    }

    // =====================================================
    // GET INPUT DATA: read tickets + their users from Zendesk
    // =====================================================
    function getInputData() {
        var tok = getToken();
        var done = existingCaseIds();
        var tickets = [];

        if (TEST_TICKET_ID) {
            tickets.push(zget(tok, '/api/v2/tickets/' + encodeURIComponent(TEST_TICKET_ID) + '.json').ticket);
        } else {
            var since = TEST_ALL_TICKETS ? 0 : Math.floor(Date.now() / 1000) - LOOKBACK_HOURS * 3600;
            var url = '/api/v2/incremental/tickets/cursor.json?start_time=' + since;
            for (var guard = 0; url && guard < 500; guard++) {
                var d = zget(tok, url);
                (d.tickets || []).forEach(function (t) {
                    if (t.status === 'deleted') return;
                    if (!TEST_ALL_TICKETS && new Date(t.created_at).getTime() / 1000 < since) return;
                    tickets.push(t);
                });
                url = d.end_of_stream ? '' : d.after_url;
            }
        }

        tickets = tickets.filter(function (t) { return t && !done['ZD-' + t.id]; });

        var userIds = [];
        tickets.forEach(function (t) {
            [t.requester_id, t.assignee_id].forEach(function (u) { if (u && userIds.indexOf(u) < 0) userIds.push(u); });
        });
        var users = userIds.length ? loadUsers(tok, userIds) : {};

        var rows = tickets.map(function (t) {
            var req = users[t.requester_id] || {}, asg = users[t.assignee_id] || {};
            var site = cfValue(t, ZD.CUSTOMER_SITE_FIELD_ID);
            return {
                id: t.id,
                subject: t.subject || ('Zendesk ticket ' + t.id),
                description: t.description || '',
                status: t.status,
                priority: t.priority,
                serviceOrderType: cfValue(t, ZD.SERVICE_ORDER_TYPE_FIELD_ID) || '',
                orgIds: [t.organization_id, site, req.orgId]                      // in priority order
                    .filter(function (x) { return x; }).map(String),
                assetIds: ticketAssetIds(t),
                requesterEmail: req.email || '',
                assigneeEmail: asg.email || ''
            };
        });

        log.audit('INPUT', {
            mode: TEST_TICKET_ID ? 'one ticket ' + TEST_TICKET_ID : (TEST_ALL_TICKETS ? 'ALL tickets' : 'last ' + LOOKBACK_HOURS + 'h'),
            toProcess: rows.length,
            alreadyHaveCase: Object.keys(done).length,
            withAsset: rows.filter(function (r) { return r.assetIds.length; }).map(function (r) {
                return '#' + r.id + ' -> ' + r.assetIds.join(', ');
            })
        });
        return rows;
    }

    // =====================================================
    // MAP: one ticket -> one case
    // =====================================================
    function map(context) {
        var t = JSON.parse(context.value);

        // 1. Asset
        var assetId = '', zdAsset = '';
        for (var i = 0; i < t.assetIds.length && !assetId; i++) {
            assetId = findOne(ASSET_RECORD_TYPE, [[ASSET_ZD_ID_FIELD, 'is', t.assetIds[i]]]);
            if (assetId) zdAsset = t.assetIds[i];
        }
        if (!assetId && REQUIRE_ASSET) {
            skip(context, t.id, t.assetIds.length
                ? 'Zendesk asset not in NetSuite (' + t.assetIds.join(', ') + ')'
                : 'No asset on ticket');
            return;
        }

        // 2. Customer: ticket org -> Customer Site -> requester org -> asset customer
        var customerId = '', customerFrom = '';
        for (var j = 0; j < t.orgIds.length && !customerId; j++) {
            customerId = findOne(search.Type.CUSTOMER, [[CUST_ZD_ORG_FIELD, 'is', t.orgIds[j]]]);
            if (customerId) customerFrom = 'Zendesk org ' + t.orgIds[j];
        }
        if (!customerId && assetId) {
            var a = search.lookupFields({ type: ASSET_RECORD_TYPE, id: assetId, columns: [ASSET_CUSTOMER_FIELD] });
            var c0 = a[ASSET_CUSTOMER_FIELD];
            customerId = Array.isArray(c0) ? (c0.length ? c0[0].value : '') : (c0 || '');
            if (customerId) customerFrom = 'asset customer';
        }
        if (!customerId) {
            skip(context, t.id, 'No NetSuite customer (orgs: ' + (t.orgIds.join(', ') || 'none') + ')');
            return;
        }

        // 3. Project: fixed, or first open project of the customer
        var projectId = CASE.PROJECT_ID;
        if (!projectId && CASE.F_PROJECT) {
            try {
                projectId = findOne(search.Type.JOB, [['customer', 'anyof', customerId], 'AND', ['isinactive', 'is', 'F']]);
            } catch (e) { projectId = ''; }
        }

        // 4. Assigned: Zendesk assignee email -> employee, else default
        var assignedId = '';
        if (t.assigneeEmail) {
            assignedId = findOne(search.Type.EMPLOYEE, [['email', 'is', t.assigneeEmail], 'AND', ['isinactive', 'is', 'F']]);
        }
        assignedId = assignedId || CASE.DEFAULT_ASSIGNED;

        // 5. Email: requester, else customer email
        var email = t.requesterEmail;
        if (!email) {
            var ce = search.lookupFields({ type: search.Type.CUSTOMER, id: customerId, columns: ['email'] });
            email = ce.email || '';
        }

        // 6. Create the case
        try {
            var c = record.create({ type: record.Type.SUPPORT_CASE, defaultValues: { customform: CASE.FORM_ID } });
            c.setValue({ fieldId: 'externalid', value: 'ZD-' + t.id });
            c.setValue({ fieldId: 'title', value: String(t.subject).slice(0, 199) });
            c.setValue({ fieldId: 'company', value: customerId });
            c.setValue({ fieldId: 'status', value: CASE.STATUS[t.status] || CASE.DEFAULT_STATUS });
            c.setValue({ fieldId: 'priority', value: CASE.PRIORITY[t.priority] || CASE.DEFAULT_PRIORITY });
            if (t.description) c.setValue({ fieldId: 'incomingmessage', value: t.description });

            trySet(c, CASE.F_CASE_TYPE, CASE.CASE_TYPE[t.serviceOrderType] || CASE.DEFAULT_CASE_TYPE, 'Case Type', t.id);
            trySet(c, CASE.F_ASSET, assetId, 'Asset', t.id);
            trySet(c, CASE.F_CASE_ASSETS, assetId ? [assetId] : '', 'Case Assets', t.id);
            trySet(c, CASE.F_PROJECT, projectId, 'Project', t.id);
            trySet(c, CASE.F_ASSIGNED, assignedId, 'Assigned', t.id);
            trySet(c, CASE.F_EMAIL, email, 'Email', t.id);
            trySet(c, CASE.F_ZD_TICKET, String(t.id), 'Zendesk ticket ID', t.id);

            var caseId = c.save({ ignoreMandatoryFields: true });
            log.audit('CASE CREATED', {
                ticket: t.id, caseId: caseId,
                customer: customerId + ' (' + customerFrom + ')',
                asset: assetId ? assetId + ' (Zendesk ' + zdAsset + ')' : '-',
                project: projectId || '-', assigned: assignedId || '-', email: email || '-',
                caseType: CASE.CASE_TYPE[t.serviceOrderType] || CASE.DEFAULT_CASE_TYPE
            });
            context.write({ key: 'ok', value: 1 });
        } catch (e) {
            log.error('CASE FAILED ticket ' + t.id, e.name + ': ' + e.message);
            context.write({ key: 'failed', value: 1 });
        }
    }

    // =====================================================
    // SUMMARIZE
    // =====================================================
    function summarize(summary) {
        var totals = { ok: 0, skipped: 0, failed: 0 }, reasons = {};
        summary.output.iterator().each(function (k, v) {
            if (k.indexOf('reason: ') === 0) reasons[k.slice(8)] = (reasons[k.slice(8)] || 0) + Number(v);
            else totals[k] = (totals[k] || 0) + Number(v);
            return true;
        });
        summary.inputSummary.error && log.error('INPUT ERROR', summary.inputSummary.error);
        summary.mapSummary.errors.iterator().each(function (k, e) { log.error('MAP ERROR ' + k, e); return true; });
        if (Object.keys(reasons).length) log.audit('SKIP REASONS (count)', reasons);
        log.audit('ZENDESK -> CASE DONE', { created: totals.ok, skipped: totals.skipped, failed: totals.failed,
                                           seconds: summary.seconds });
    }

    return { getInputData: getInputData, map: map, summarize: summarize };
});