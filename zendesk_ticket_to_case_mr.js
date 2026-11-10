/**
 * @NApiVersion 2.1
 * @NScriptType MapReduceScript
 * @NModuleScope SameAccount
 *
 * Zendesk Ticket -> NetSuite Support Case  (CREATE ONLY)
 *
 * For each Zendesk ticket:
 *   1. Organization  -> NetSuite Customer whose custentity_organization_id = ticket.organization_id
 *   2. Asset         -> NetSuite Field Service Asset whose custrecord_asset_id = asset on the ticket
 *                       (Bot asset or assembly_item, read from the ticket's asset lookup fields)
 *   3. Both found    -> create the Support Case (externalid = ZD-<ticket id>)
 *      Not found     -> skipped, reason logged (create the Org/Asset first, then re-run)
 * Tickets that already have a case (externalid ZD-<id>) are skipped.
 *
 * TEST:  TEST_ALL_TICKETS = true  -> every ticket in Zendesk
 * LIVE:  TEST_ALL_TICKETS = false -> only tickets created in the last LOOKBACK_HOURS
 * One ticket: TEST_TICKET_ID = '123'
 *
 * No script parameters: set everything below.
 */
define(['N/https', 'N/record', 'N/search', 'N/log'],
function (https, record, search, log) {

    // =====================================================
    // CONFIG
    // =====================================================
    var ZD = {
        BASE_URL: 'https://mytra.zendesk.com',
        CLIENT_ID: 'netsuite_fsm_integration',
        CLIENT_SECRET: 'PASTE_ZENDESK_CLIENT_SECRET_HERE',
        SCOPE: 'read',

        // Ticket fields holding the asset (Zendesk ticket field IDs, numbers).
        // Leave [] to auto-detect every ticket lookup field whose title contains "asset".
        ASSET_FIELD_IDS: []
    };

    var TEST_ALL_TICKETS = true;   // true = all tickets (testing), false = new tickets only
    var LOOKBACK_HOURS = 24;       // live mode: tickets created in the last N hours
    var TEST_TICKET_ID = '';       // one ticket only, e.g. '1234'

    var REQUIRE_ASSET = true;      // false = create the case even when no asset is found

    // NetSuite field IDs
    var CUST_ZD_ORG_FIELD = 'custentity_organization_id';
    var ASSET_RECORD_TYPE = 'customrecord_nx_asset';
    var ASSET_ZD_ID_FIELD = 'custrecord_asset_id';

    var CASE = {
        asset:      'custevent_nx_case_asset', // VERIFY: field help on the Case "Asset" field
        zdTicketId: '',                        // optional custom field for the ticket ID ('' = not set)
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
        var out = { code: Number(res.code), data: parse(res.body) };
        if (out.code !== 200) {
            log.error('Zendesk GET ' + urlOrPath, { httpCode: out.code, response: out.data });
            throw Error('Zendesk GET failed: HTTP ' + out.code);
        }
        return out.data;
    }

    function assetFieldIds(tok) {
        if (ZD.ASSET_FIELD_IDS.length) return ZD.ASSET_FIELD_IDS.map(Number);
        var d = zget(tok, '/api/v2/ticket_fields.json');
        var ids = (d.ticket_fields || []).filter(function (f) {
            return f.type === 'lookup' && /asset/i.test(f.title || '');
        });
        log.audit('Asset ticket fields (auto-detected)', ids.map(function (f) {
            return f.id + ' = ' + f.title + ' -> ' + (f.relationship_target_type || '');
        }));
        return ids.map(function (f) { return Number(f.id); });
    }

    function ticketAssetIds(ticket, fieldIds) {
        var out = [];
        (ticket.custom_fields || []).forEach(function (cf) {
            if (fieldIds.indexOf(Number(cf.id)) < 0 || cf.value == null || cf.value === '') return;
            (Array.isArray(cf.value) ? cf.value : [cf.value]).forEach(function (v) {
                if (v) out.push(String(v));
            });
        });
        return out;
    }

    function existingCaseIds() {
        var ids = {};
        search.create({
            type: search.Type.SUPPORT_CASE,
            filters: [['externalidstring', 'startswith', 'ZD-']],
            columns: ['externalid']
        }).run().each(function (r) {
            ids[String(r.getValue('externalid'))] = true;
            return true;   // up to 4,000 - fine for this check
        });
        return ids;
    }

    function findOne(type, field, value) {
        var id = '';
        search.create({ type: type, filters: [[field, 'is', String(value)]], columns: ['internalid'] })
            .run().each(function (r) { id = r.id; return false; });
        return id;
    }

    // =====================================================
    // GET INPUT DATA: read tickets from Zendesk
    // =====================================================
    function getInputData() {
        var tok = getToken();
        var fieldIds = assetFieldIds(tok);
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

        var rows = [];
        tickets.forEach(function (t) {
            if (!t || done['ZD-' + t.id]) return;
            rows.push({
                id: t.id,
                subject: t.subject || ('Zendesk ticket ' + t.id),
                description: t.description || '',
                status: t.status,
                priority: t.priority,
                orgId: t.organization_id ? String(t.organization_id) : '',
                assetIds: ticketAssetIds(t, fieldIds)
            });
        });

        log.audit('INPUT', {
            mode: TEST_TICKET_ID ? 'one ticket ' + TEST_TICKET_ID : (TEST_ALL_TICKETS ? 'ALL tickets' : 'last ' + LOOKBACK_HOURS + 'h'),
            ticketsRead: tickets.length,
            alreadyHaveCase: tickets.length - rows.length,
            toProcess: rows.length,
            assetFieldIds: fieldIds
        });
        return rows;
    }

    // =====================================================
    // MAP: one ticket -> one case
    // =====================================================
    function map(context) {
        var t = JSON.parse(context.value);

        // 1. Organization -> Customer
        var customerId = t.orgId ? findOne(search.Type.CUSTOMER, CUST_ZD_ORG_FIELD, t.orgId) : '';
        if (!customerId) {
            log.audit('SKIPPED ticket ' + t.id, 'No NetSuite customer for Zendesk org ' + (t.orgId || '(none on ticket)'));
            context.write({ key: 'skipped', value: 1 });
            return;
        }

        // 2. Asset (Bot or assembly item) -> Field Service Asset
        var assetId = '';
        for (var i = 0; i < t.assetIds.length && !assetId; i++) {
            assetId = findOne(ASSET_RECORD_TYPE, ASSET_ZD_ID_FIELD, t.assetIds[i]);
        }
        if (!assetId && REQUIRE_ASSET) {
            log.audit('SKIPPED ticket ' + t.id, 'No NetSuite asset for Zendesk asset ' +
                      (t.assetIds.length ? t.assetIds.join(', ') : '(none on ticket)'));
            context.write({ key: 'skipped', value: 1 });
            return;
        }

        // 3. Create the case
        try {
            var c = record.create({ type: record.Type.SUPPORT_CASE });
            c.setValue({ fieldId: 'externalid', value: 'ZD-' + t.id });
            c.setValue({ fieldId: 'title', value: String(t.subject).slice(0, 199) });
            c.setValue({ fieldId: 'company', value: customerId });
            c.setValue({ fieldId: 'status', value: CASE.STATUS[t.status] || CASE.DEFAULT_STATUS });
            c.setValue({ fieldId: 'priority', value: CASE.PRIORITY[t.priority] || CASE.DEFAULT_PRIORITY });
            if (t.description) c.setValue({ fieldId: 'incomingmessage', value: t.description });
            if (assetId && CASE.asset) c.setValue({ fieldId: CASE.asset, value: assetId });
            if (CASE.zdTicketId) c.setValue({ fieldId: CASE.zdTicketId, value: String(t.id) });

            var caseId = c.save({ ignoreMandatoryFields: true });
            log.audit('CASE CREATED', { ticket: t.id, caseId: caseId, customer: customerId, asset: assetId || '-' });
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
        var totals = { ok: 0, skipped: 0, failed: 0 };
        summary.output.iterator().each(function (k, v) { totals[k] = (totals[k] || 0) + Number(v); return true; });
        summary.inputSummary.error && log.error('INPUT ERROR', summary.inputSummary.error);
        summary.mapSummary.errors.iterator().each(function (k, e) { log.error('MAP ERROR ' + k, e); return true; });
        log.audit('ZENDESK -> CASE DONE', { created: totals.ok, skipped: totals.skipped, failed: totals.failed,
                                           seconds: summary.seconds });
    }

    return { getInputData: getInputData, map: map, summarize: summarize };
});
