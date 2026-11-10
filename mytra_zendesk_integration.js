/**
 * @NApiVersion 2.1
 * @NScriptType MapReduceScript
 * @NModuleScope SameAccount
 *
 * Field Service Asset -> Zendesk  (CREATE ONLY, 100% saved-search driven mapping)
 *
 * PARENT asset (Parent empty)  -> Zendesk Organization (if customer has none) + ITAM Asset
 * CHILD asset  (Parent filled) -> Zendesk "assembly_item" record, bot_parent = parent's Zendesk ID
 * The Zendesk ID is written back to custrecord_asset_id (asset) / custentity_organization_id (customer).
 *
 * =============================================================================
 *  MAPPING = SAVED SEARCH CUSTOM LABELS   (no code change to add/remove a field)
 * =============================================================================
 *   <target>.<zendesk_field_key>[|type]
 *
 *   org.<key>       Zendesk Organization field        org.name, org.notes, org.details
 *   org_cf.<key>    Organization custom field          org_cf.city, org_cf.poc_email
 *   asset.<key>     Zendesk ITAM Asset field (parent)  asset.serial_number, asset.model
 *   asset_cf.<key>  ITAM Asset custom field            asset_cf.contract_status
 *   asm.<key>       assembly_item field (child)        asm.item_number, asm.revision|integer
 *
 *   type (optional): text (default) | value | date | number | integer | bool | list
 *     text  = display text for list/record fields, else raw value
 *     value = raw value (internal ID for list/record fields)
 *     date  = NetSuite date -> YYYY-MM-DD
 *     list  = comma separated -> array (e.g. org.domain_names|list, org.tags|list)
 *
 *   Special keys resolved by the script:
 *     asset.asset_type  NetSuite type name  -> Zendesk asset_type_id (matched by name)
 *     asset.status      NetSuite status name -> Zendesk status_id (by name, then STATUS_MAP)
 *     asset.name / asm.name  -> record name (default = NetSuite asset Name)
 *     org.name          -> organization name (default = customer company name)
 *
 *   Set by the script (do not map): external_id, organization_id, bot_parent
 *
 * CONTROL labels (script logic, not sent):
 *   id, name, zd_id, parent_id, parent_zd_id, customer_id, cust_zd_org_id
 *   Required: id, name, parent_id, parent_zd_id, customer_id, cust_zd_org_id
 *   zd_id (= custrecord_asset_id) is strongly recommended: already-synced assets are skipped.
 *
 * Labels that match nothing are ignored and listed in the INPUT audit log.
 *
 * No script parameters: set CLIENT_SECRET, SEARCH_ID and TEST_ASSET_ID below.
 */
define(['N/https', 'N/record', 'N/search', 'N/format', 'N/log'],
function (https, record, search, format, log) {

    // =====================================================
    // 1. ZENDESK CONFIG
    // =====================================================
    var ZD = {
        BASE_URL: 'https://mytra.zendesk.com',
        CLIENT_ID: 'netsuite_fsm_integration',
        CLIENT_SECRET: '4f1beaf8b4a16f576d75f7bc4d8e77d63ac1d07a23d6f4293036c4fe62ef5779',
        SCOPE: 'read write',

        PARENT_TYPE_NAME: 'Bot',   // used when asset.asset_type is blank / not found in Zendesk

        DEFAULT_STATUS_ID: '01KKM6AZ63CRKT2TPZJSHJ5E7W',     // Available
        STATUS_MAP: {
            'available':         '01KKM6AZ63CRKT2TPZJSHJ5E7W', // Available
            'operational':       '01KKM6AZ7N68ESYBWFGAS9T98R', // In use
            'in transit':        '01KKM6AZDZMGVVH3DRAVD3AANN', // On hold
            'under inspection':  '01KKM6AZDZMGVVH3DRAVD3AANN', // On hold
            'in repair':         '01KKM6AZ9A0D10FKS5VY5HPMFG', // Under repair
            'under maintenance': '01KKM6AZ9A0D10FKS5VY5HPMFG', // Under repair
            'decommissioned':    '01KKM6AZFMN4ZZ61A36KCY86E2'  // Retired
        },

        DEFAULT_MANUFACTURER: 'Mytra',   // only when asset.manufacturer is not mapped; '' = never

        CHILD_OBJECT_KEY: 'assembly_item',
        CHILD_RETRY_WITHOUT: ['serial_number']  // on HTTP 422, retry once without these
    };

    // =====================================================
    // 2. NETSUITE IDS
    // =====================================================
    var ASSET_RECORD_TYPE = 'customrecord_nx_asset';
    var SEARCH_ID = 'customsearch_mytra_field_service_asset';
    var TEST_ASSET_ID = '';   // e.g. '232' to process one asset only

    var ASSET = {
        zdAssetId: 'custrecord_asset_id',
        // fallback lookup only (parent not returned by the saved search)
        customer:  'custrecord_nx_asset_customer',
        assetType: 'custrecord_nx_asset_type',
        status:    'custrecord_asset_statuses'
    };
    var CUST = { zdOrgId: 'custentity_organization_id' };

    // =====================================================
    // 3. LABEL CONFIG
    // =====================================================
    var CONTROL = {
        id:         'id',
        name:       'name',
        zdId:       'zd_id',
        parentId:   'parent_id',
        parentZdId: 'parent_zd_id',
        customerId: 'customer_id',
        cZdOrgId:   'cust_zd_org_id'
    };
    var REQUIRED = ['id', 'name', 'parent_id', 'parent_zd_id', 'customer_id', 'cust_zd_org_id'];

    var TARGETS = {
        'org': 'org', 'org_cf': 'orgCf',
        'asset': 'asset', 'asset_cf': 'assetCf',
        'asm': 'asm'
    };

    function emptyFields() { return { org: {}, orgCf: {}, asset: {}, assetCf: {}, asm: {} }; }

    // =====================================================
    // HELPERS
    // =====================================================
    function parse(body) {
        try { return JSON.parse(body); } catch (e) { return { raw: body }; }
    }

    function norm(v) {
        return String(v || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
    }

    function toIsoDate(nsDate) {
        if (!nsDate) return '';
        try {
            var d = format.parse({ value: nsDate, type: format.Type.DATE });
            return d.getFullYear() + '-' +
                ('0' + (d.getMonth() + 1)).slice(-2) + '-' +
                ('0' + d.getDate()).slice(-2);
        } catch (e) {
            return '';
        }
    }

    function clean(obj) {
        var out = {};
        Object.keys(obj || {}).forEach(function (k) {
            var v = obj[k];
            if (v === '' || v === null || v === undefined) return;
            if (Array.isArray(v) && !v.length) return;
            out[k] = v;
        });
        return out;
    }

    // "Parent Name : Child Name" -> "Child Name"
    function cleanName(n) {
        var parts = String(n || '').split(' : ');
        return parts[parts.length - 1].trim();
    }

    function convert(v, type) {
        if (v === null || v === undefined || v === '') return '';
        switch (type) {
            case 'date':    return toIsoDate(v);
            case 'number':  var f = parseFloat(v);   return isNaN(f) ? '' : f;
            case 'integer': var i = parseInt(v, 10); return isNaN(i) ? '' : i;
            case 'bool':    return v === true || v === 'T' || String(v).toLowerCase() === 'true';
            case 'list':    return String(v).split(',').map(function (x) { return x.trim(); })
                                .filter(function (x) { return x; });
            default:        return String(v);
        }
    }

    function api(token, method, endpoint, payload) {
        var opts = {
            url: ZD.BASE_URL + endpoint,
            headers: {
                Authorization: 'Bearer ' + token,
                Accept: 'application/json',
                'Content-Type': 'application/json'
            }
        };
        if (payload) opts.body = JSON.stringify(payload);

        var res = method === 'POST' ? https.post(opts) : https.get(opts);
        var out = { code: Number(res.code), data: parse(res.body) };

        if (out.code < 200 || out.code >= 300) {
            log.error('Zendesk ' + method + ' ' + endpoint, {
                httpCode: out.code, request: payload || null, response: out.data
            });
        }
        return out;
    }

    function getSecret() {
        var s = ZD.CLIENT_SECRET;
        if (!s || s.indexOf('PASTE_') === 0) throw Error('Set ZD.CLIENT_SECRET at the top of the script');
        return s;
    }

    function getToken() {
        var res = https.post({
            url: ZD.BASE_URL + '/oauth/tokens',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({
                grant_type: 'client_credentials',
                client_id: ZD.CLIENT_ID,
                client_secret: getSecret(),
                scope: ZD.SCOPE
            })
        });

        var data = parse(res.body);
        if (Number(res.code) !== 200 || !data.access_token) {
            throw Error('Zendesk OAuth failed: ' + res.code + ' ' + JSON.stringify(data));
        }
        return data.access_token;
    }

    function saveZdId(recType, id, fieldId, zdId) {
        var v = {};
        v[fieldId] = String(zdId);
        record.submitFields({
            type: recType, id: id, values: v,
            options: { enableSourcing: false, ignoreMandatoryFields: true }
        });
    }

    // =====================================================
    // SAVED SEARCH -> COLUMN PLAN
    // =====================================================
    function buildPlan(columns) {
        var plan = { control: {}, dyn: [], ignored: [] };
        var labelToKey = {};
        Object.keys(CONTROL).forEach(function (k) { labelToKey[CONTROL[k]] = k; });

        columns.forEach(function (col) {
            var raw = String(col.label || '').trim();
            if (!raw) return;
            var lower = raw.toLowerCase();

            if (labelToKey[lower]) { plan.control[labelToKey[lower]] = col; return; }

            var dot = raw.indexOf('.');
            if (dot > 0) {
                var target = TARGETS[raw.slice(0, dot).toLowerCase()];
                if (target) {
                    var rest = raw.slice(dot + 1).split('|');
                    var key = rest[0].trim();
                    if (key) {
                        plan.dyn.push({
                            target: target, key: key,
                            type: (rest[1] || '').trim().toLowerCase(), col: col
                        });
                        return;
                    }
                }
            }
            plan.ignored.push(raw);
        });

        var missing = REQUIRED.filter(function (lbl) { return !plan.control[labelToKey[lbl]]; });
        if (missing.length) {
            throw Error('Saved search is missing columns with Custom Label: ' + missing.join(', '));
        }
        return plan;
    }

    function readCell(r, col, type) {
        var v;
        if (type === 'value') {
            v = r.getValue(col);
        } else {
            v = r.getText(col);
            if (v === null || v === undefined || v === '') v = r.getValue(col);
        }
        return convert(v, type);
    }

    function rowToObj(r, plan) {
        var o = { fields: emptyFields() };

        Object.keys(CONTROL).forEach(function (k) {
            var col = plan.control[k];
            var v = col ? r.getValue(col) : '';
            o[k] = v == null ? '' : String(v);
        });
        if (!o.id) o.id = String(r.id);
        o.name = cleanName(o.name);

        plan.dyn.forEach(function (d) {
            var v = readCell(r, d.col, d.type);
            if (v !== '' && !(Array.isArray(v) && !v.length)) o.fields[d.target][d.key] = v;
        });
        return o;
    }

    function runSearch(onlyIds) {
        var s = search.load({ id: SEARCH_ID });
        if (onlyIds && onlyIds.length) {
            s.filters.push(search.createFilter({
                name: 'internalid', operator: search.Operator.ANYOF, values: onlyIds.map(String)
            }));
        }
        var plan = buildPlan(s.columns);

        var rows = [];
        var paged = s.runPaged({ pageSize: 1000 });
        paged.pageRanges.forEach(function (pr) {
            paged.fetch({ index: pr.index }).data.forEach(function (r) {
                rows.push(rowToObj(r, plan));
            });
        });
        return { rows: rows, plan: plan };
    }

    // =====================================================
    // ORGANIZATION
    // =====================================================
    function getOrCreateOrg(S, a) {
        var customerId = a.customerId;
        if (S.orgCache[customerId]) return S.orgCache[customerId];

        // value from the search, else re-check the customer (may have been set earlier in this run)
        var orgId = a.cZdOrgId;
        var cust = null;
        if (!orgId) {
            cust = search.lookupFields({
                type: search.Type.CUSTOMER, id: customerId,
                columns: [CUST.zdOrgId, 'companyname', 'entityid']
            });
            orgId = cust[CUST.zdOrgId];
        }
        if (orgId) {
            S.orgCache[customerId] = String(orgId);
            return S.orgCache[customerId];
        }

        var org = clean(a.fields.org);
        if (!org.name) org.name = cust.companyname || cust.entityid;
        if (!org.name) throw Error('Customer ' + customerId + ' has no name');
        org.name = String(org.name);
        org.external_id = 'NS-CUST-' + customerId;

        var cf = clean(a.fields.orgCf);
        if (Object.keys(cf).length) org.organization_fields = cf;

        var ep = '/api/v2/organizations/create_or_update.json';
        var res = api(S.token, 'POST', ep, { organization: org });
        orgId = res.data.organization && res.data.organization.id;

        // Custom fields rejected -> create with standard fields only
        if (!orgId && org.organization_fields) {
            log.audit('Org retry without organization_fields', org.name);
            delete org.organization_fields;
            res = api(S.token, 'POST', ep, { organization: org });
            orgId = res.data.organization && res.data.organization.id;
        }

        // Name already used in Zendesk -> reuse that org
        if (!orgId && res.code === 422) {
            var f = api(S.token, 'GET',
                '/api/v2/organizations/search.json?name=' + encodeURIComponent(org.name));
            var orgs = (f.data && f.data.organizations) || [];
            if (orgs.length === 1) orgId = orgs[0].id;
        }

        if (!orgId) throw Error('Could not create/find Zendesk Organization for ' + org.name);

        saveZdId(record.Type.CUSTOMER, customerId, CUST.zdOrgId, orgId);
        log.audit('ORG CREATED', { customerId: customerId, zendeskOrgId: orgId, sent: org });

        S.orgCache[customerId] = String(orgId);
        return S.orgCache[customerId];
    }

    // =====================================================
    // STATUS (by name)
    // =====================================================
    function getStatusId(S, nsStatus) {
        if (!nsStatus) return ZD.DEFAULT_STATUS_ID;

        if (!S.statuses) {
            var res = api(S.token, 'GET', '/api/v2/it_asset_management/statuses');
            if (res.code !== 200) throw Error('Could not read Zendesk statuses');
            S.statuses = res.data.statuses || [];
        }

        var key = norm(nsStatus);
        for (var i = 0; i < S.statuses.length; i++) {
            if (norm(S.statuses[i].name) === key || norm(S.statuses[i].external_id) === key) {
                return String(S.statuses[i].id);
            }
        }
        var mapped = ZD.STATUS_MAP[String(nsStatus).trim().toLowerCase()];
        if (mapped) return mapped;

        throw Error('No Zendesk status for NetSuite status "' + nsStatus + '"');
    }

    // =====================================================
    // ASSET TYPE (by name)
    // =====================================================
    function getAssetTypeId(S, nsTypeName) {
        if (!S.assetTypes) {
            var res = api(S.token, 'GET', '/api/v2/it_asset_management/asset_types');
            if (res.code !== 200) throw Error('Could not read Zendesk asset types');
            S.assetTypes = res.data.asset_types || [];
        }

        function find(name) {
            var k = norm(name);
            if (!k) return '';
            for (var i = 0; i < S.assetTypes.length; i++) {
                if (norm(S.assetTypes[i].name) === k) return String(S.assetTypes[i].id);
            }
            return '';
        }

        var id = find(nsTypeName) || find(ZD.PARENT_TYPE_NAME);
        if (!id) {
            throw Error('No Zendesk asset type for "' + (nsTypeName || '(blank)') +
                '". Zendesk has: ' + S.assetTypes.map(function (t) { return t.name; }).join(', '));
        }
        return id;
    }

    // =====================================================
    // CREATE PARENT (ITAM asset)
    // =====================================================
    function createParentAsset(S, a) {
        if (!a.customerId) throw Error('Asset ' + a.id + ': Customer missing');

        var f = clean(a.fields.asset);
        var asset = {};
        Object.keys(f).forEach(function (k) {
            if (k !== 'asset_type' && k !== 'status') asset[k] = f[k];
        });

        asset.name = String(f.name || a.name || '');
        if (!asset.name) throw Error('Asset ' + a.id + ': Name missing');
        asset.external_id = 'NS-ASSET-' + a.id;
        asset.asset_type_id = f.asset_type_id || getAssetTypeId(S, f.asset_type);
        asset.status_id = f.status_id || getStatusId(S, f.status);
        asset.organization_id = Number(getOrCreateOrg(S, a));
        if (!asset.manufacturer && ZD.DEFAULT_MANUFACTURER) asset.manufacturer = ZD.DEFAULT_MANUFACTURER;

        var cf = clean(a.fields.assetCf);
        if (Object.keys(cf).length) asset.custom_field_values = cf;

        var res = api(S.token, 'POST', '/api/v2/it_asset_management/assets', { asset: asset });
        if (res.code !== 201 || !res.data.asset || !res.data.asset.id) {
            throw Error('Parent asset ' + a.id + ' create failed: HTTP ' + res.code);
        }

        var zdId = String(res.data.asset.id);
        saveZdId(ASSET_RECORD_TYPE, a.id, ASSET.zdAssetId, zdId);
        log.audit('PARENT ASSET CREATED', { netsuiteId: a.id, zendeskAssetId: zdId, sent: asset });
        return zdId;
    }

    // Parent not in this batch: read it through the same saved search;
    // fall back to a minimal lookup if the search excludes it.
    function loadParent(id) {
        var found = runSearch([id]).rows.filter(function (r) { return String(r.id) === String(id); });
        if (found.length) return found[0];

        var r = search.lookupFields({
            type: ASSET_RECORD_TYPE, id: id,
            columns: ['name', ASSET.zdAssetId, ASSET.customer, ASSET.assetType, ASSET.status]
        });
        function v(f) { var x = r[f]; return Array.isArray(x) ? (x.length ? x[0].value : '') : (x || ''); }
        function t(f) { var x = r[f]; return Array.isArray(x) ? (x.length ? x[0].text : '') : (x || ''); }
        log.audit('Parent not in saved search, using minimal lookup', id);

        var fields = emptyFields();
        fields.asset = clean({ asset_type: t(ASSET.assetType), status: t(ASSET.status) });
        return {
            id: String(id), name: cleanName(t('name')), zdId: v(ASSET.zdAssetId),
            customerId: v(ASSET.customer), cZdOrgId: '', fields: fields
        };
    }

    // =====================================================
    // CREATE CHILD (assembly_item custom object record)
    // =====================================================
    function createChild(S, c, parentZdId) {
        var f = clean(c.fields.asm);
        var recName = f.name || c.name || ('Assembly ' + c.id);
        delete f.name;
        f.bot_parent = parentZdId;

        var payload = {
            custom_object_record: {
                name: String(recName),
                external_id: 'NS-ASM-' + c.id,
                custom_object_fields: f
            }
        };

        var ep = '/api/v2/custom_objects/' + ZD.CHILD_OBJECT_KEY + '/records';
        var res = api(S.token, 'POST', ep, payload);
        var rec = res.data && res.data.custom_object_record;

        if ((!rec || !rec.id) && res.code === 422) {
            var dropped = ZD.CHILD_RETRY_WITHOUT.filter(function (k) { return k in f; });
            if (dropped.length) {
                log.audit('Child retry without fields', { asset: c.id, dropped: dropped });
                dropped.forEach(function (k) { delete f[k]; });
                res = api(S.token, 'POST', ep, payload);
                rec = res.data && res.data.custom_object_record;
            }
        }
        if (!rec || !rec.id) throw Error('Child ' + c.id + ' create failed: HTTP ' + res.code);

        saveZdId(ASSET_RECORD_TYPE, c.id, ASSET.zdAssetId, rec.id);
        log.audit('CHILD CREATED', { netsuiteId: c.id, assemblyItemId: rec.id, sent: payload });
        return rec.id;
    }

    // =====================================================
    // GET INPUT DATA
    // =====================================================
    function getInputData() {
        var out = runSearch(TEST_ASSET_ID ? [TEST_ASSET_ID] : null);

        log.audit('INPUT', {
            savedSearch: SEARCH_ID,
            assetsToProcess: out.rows.length,
            onlyAssetId: TEST_ASSET_ID || 'all',
            mappedColumns: out.plan.dyn.map(function (d) {
                return d.target + '.' + d.key + (d.type ? '|' + d.type : '');
            }),
            ignoredLabels: out.plan.ignored,
            hasZdIdColumn: !!out.plan.control.zdId
        });
        return out.rows;
    }

    // =====================================================
    // MAP: group child with its parent
    // =====================================================
    function map(context) {
        var a = JSON.parse(context.value);
        context.write({ key: String(a.parentId || a.id), value: a });
    }

    // =====================================================
    // REDUCE: one parent + all its children
    // =====================================================
    function reduce(context) {
        var rootId = context.key;
        var items = context.values.map(function (v) { return JSON.parse(v); });

        var root = null, children = [];
        items.forEach(function (a) {
            if (!a.parentId && String(a.id) === rootId) root = a; else children.push(a);
        });

        var pending = children.filter(function (c) { return !c.zdId; });
        var skipped = children.length - pending.length + (root && root.zdId ? 1 : 0);
        if (skipped) context.write({ key: 'skipped', value: skipped });

        if (!pending.length && (!root || root.zdId)) return;   // nothing to create

        var S = { token: getToken(), orgCache: {}, statuses: null, assetTypes: null };
        var ok = 0, failed = 0;

        // ---------- parent ----------
        var parentZdId = (root && root.zdId) || '';
        children.forEach(function (c) { if (!parentZdId && c.parentZdId) parentZdId = c.parentZdId; });

        try {
            if (!parentZdId) {
                var p = root || loadParent(rootId);
                if (p.zdId) {
                    parentZdId = p.zdId;
                } else {
                    parentZdId = createParentAsset(S, p);
                    ok++;
                }
            }
        } catch (e) {
            log.error('PARENT FAILED ' + rootId, e.message);
            context.write({ key: 'failed', value: 1 + pending.length });
            return; // children need the parent
        }

        // ---------- children ----------
        pending.forEach(function (c) {
            try {
                createChild(S, c, parentZdId);
                ok++;
            } catch (e) {
                failed++;
                log.error('CHILD FAILED ' + c.id, e.message);
            }
        });

        if (ok) context.write({ key: 'ok', value: ok });
        if (failed) context.write({ key: 'failed', value: failed });
    }

    // =====================================================
    // SUMMARIZE
    // =====================================================
    function summarize(summary) {
        var totals = { ok: 0, failed: 0, skipped: 0 };
        summary.output.iterator().each(function (k, v) {
            totals[k] = (totals[k] || 0) + Number(v);
            return true;
        });

        summary.inputSummary.error && log.error('INPUT ERROR', summary.inputSummary.error);
        summary.mapSummary.errors.iterator().each(function (k, e) { log.error('MAP ERROR ' + k, e); return true; });
        summary.reduceSummary.errors.iterator().each(function (k, e) { log.error('REDUCE ERROR ' + k, e); return true; });

        log.audit('ZENDESK SYNC DONE', {
            created: totals.ok,
            failed: totals.failed,
            skippedAlreadySynced: totals.skipped,
            seconds: summary.seconds,
            usage: summary.usage
        });
    }

    return { getInputData: getInputData, map: map, reduce: reduce, summarize: summarize };
});