/**
 * @NApiVersion 2.1
 * @NScriptType MapReduceScript
 * @NModuleScope SameAccount
 *
 * Field Service Asset -> Zendesk  (CREATE ONLY)
 *
 * PARENT asset (Parent field empty, Asset Type mapped e.g. Bot)
 *   1. Customer has Zendesk Org ID?  yes -> use it | no -> create Org (+address), save ID on Customer
 *   2. Create Zendesk ITAM Asset under that Org
 *   3. Save Zendesk Asset ID on the NetSuite asset
 *
 * CHILD asset (Parent field populated)
 *   1. Parent has Zendesk Asset ID?  yes -> use it
 *                                    no  -> create Org (if needed) + Parent asset first, save ID on parent
 *   2. Create "assembly_item" custom object record with bot_parent = parent Zendesk Asset ID
 *   3. Save the assembly_item record ID on the child NetSuite asset
 *
 * Why grouped: every child is grouped with its parent (reduce key = parent ID),
 * so a parent is created once even when many children are processed together.
 *
 * INPUT = your SAVED SEARCH. Columns are read by their CUSTOM LABEL
 * (see SEARCH_LABELS below), so column order does not matter.
 *
 * No script parameters: set CLIENT_SECRET, SEARCH_ID and TEST_ASSET_ID below.
 */
define(['N/https', 'N/record', 'N/search', 'N/runtime', 'N/format', 'N/log'],
function (https, record, search, runtime, format, log) {

    // =====================================================
    // 1. ZENDESK CONFIG
    // =====================================================
    var ZD = {
        BASE_URL: 'https://mytra.zendesk.com',
        CLIENT_ID: 'netsuite_fsm_integration',
        CLIENT_SECRET: '4f1beaf8b4a16f576d75f7bc4d8e77d63ac1d07a23d6f4293036c4fe62ef5779',
        SCOPE: 'read write',

        // Asset type is matched BY NAME: NetSuite Asset Type text -> Zendesk asset type
        // with the same name (read live from Zendesk, no IDs hardcoded).
        // Children are always children of a Bot, so if a parent has to be created
        // and its type is blank / has no Zendesk match, this Zendesk type name is used:
        PARENT_TYPE_NAME: 'Bot',

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

        DEFAULT_MANUFACTURER: 'Mytra',
        CONTRACT_STATUS_KEY: '',          // no Zendesk field yet -> not sent

        CHILD_OBJECT_KEY: 'assembly_item' // Zendesk custom object for children
    };

    // =====================================================
    // 2. NETSUITE IDS
    // =====================================================
    var ASSET_RECORD_TYPE = 'customrecord_nx_asset';  // Field Service Asset record
    var SEARCH_ID = 'customsearch_mytra_field_service_asset';  // saved search

    // TEST: put one asset internal ID (e.g. '232') to process only that asset.
    // Leave '' to process everything the saved search returns.
    var TEST_ASSET_ID = '';

    var ASSET = {
        zdAssetId:      'custrecord_asset_id',          // Zendesk ID written back (asset ID or assembly_item ID)
        parent:         'parent',                       // VERIFY: Field Help on "Parent"
        name:           'name',
        customer:       'custrecord_nx_asset_customer',
        item:           'custrecord_nx_asset_item',
        serial:         'custrecord_nx_asset_serial',
        assetType:      'custrecord_nx_asset_type',
        status:         'custrecord_asset_statuses',
        contractStatus: 'custrecord_asset_status',
        warrantyEnd:    'custrecord_warranty_end_date',

        // CHILD (assembly_item) extra fields - put field IDs, '' = not sent
        revision:       '',
        unitCost:       '',
        unitOfMeasure:  '',
        installDate:    ''
    };

    var CUST = {
        zdOrgId: 'custentity_organization_id'
    };

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
        Object.keys(obj).forEach(function (k) {
            if (obj[k] !== '' && obj[k] !== null && obj[k] !== undefined) out[k] = obj[k];
        });
        return out;
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

    function getToken() {
        var secret = ZD.CLIENT_SECRET;

        var res = https.post({
            url: ZD.BASE_URL + '/oauth/tokens',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({
                grant_type: 'client_credentials',
                client_id: ZD.CLIENT_ID,
                client_secret: secret,
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
    // SAVED SEARCH COLUMNS  (Custom Label in the search -> script key)
    //   t: true  = read the TEXT of the column (list/record fields)
    //   req: true = column must exist in the search
    // =====================================================
    var SEARCH_LABELS = {
        // ----- Asset -----
        id:             { label: 'id',              req: true },
        name:           { label: 'name',            req: true },
        zdId:           { label: 'zd_id',           req: true }, // THIS asset's own custrecord_asset_id
        parentId:       { label: 'parent_id',       req: true },
        parentZdId:     { label: 'parent_zd_id',    req: true },
        customerId:     { label: 'customer_id',     req: true },
        assetType:      { label: 'asset_type',      t: true }, // name, e.g. "Bot"; blank OK on children
        itemText:       { label: 'item',            t: true },
        serial:         { label: 'serial' },
        status:         { label: 'status',          t: true },
        contractStatus: { label: 'contract_status', t: true },
        warrantyEnd:    { label: 'warranty_end' },
        revision:       { label: 'revision' },
        unitCost:       { label: 'unit_cost' },
        unitOfMeasure:  { label: 'unit_of_measure', t: true },
        installDate:    { label: 'install_date' },

        // ----- Customer (Zendesk Organization) -----
        c_zdOrgId:      { label: 'cust_zd_org_id',  req: true },
        c_company:      { label: 'cust_company',    req: true },
        c_entityid:     { label: 'cust_entityid' },
        c_addr1:        { label: 'cust_address' },
        c_city:         { label: 'cust_city' },
        c_state:        { label: 'cust_state' },
        c_zip:          { label: 'cust_zip' },
        c_email:        { label: 'cust_email' },
        c_phone:        { label: 'cust_phone' }
    };

    function columnIndex(columns) {
        var byLabel = {};
        columns.forEach(function (col) {
            if (col.label) byLabel[String(col.label).trim().toLowerCase()] = col;
        });

        var missing = [];
        Object.keys(SEARCH_LABELS).forEach(function (k) {
            var d = SEARCH_LABELS[k];
            if (d.req && !byLabel[d.label]) missing.push(d.label);
        });
        if (missing.length) {
            throw Error('Saved search is missing columns with Custom Label: ' + missing.join(', '));
        }
        return byLabel;
    }

    function rowToObj(r, byLabel) {
        var o = {};
        Object.keys(SEARCH_LABELS).forEach(function (k) {
            var d = SEARCH_LABELS[k];
            var col = byLabel[d.label];
            if (!col) { o[k] = ''; return; }
            var v = d.t ? (r.getText(col) || r.getValue(col)) : r.getValue(col);
            o[k] = v == null ? '' : String(v);
        });
        o.name = cleanName(o.name);
        return o;
    }

    // "Parent Name : Child Name" -> "Child Name"
    function cleanName(n) {
        var parts = String(n || '').split(' : ');
        return parts[parts.length - 1].trim();
    }

    function custFrom(o) {
        return {
            zdOrgId: o.c_zdOrgId, company: o.c_company, entityid: o.c_entityid,
            addr1: o.c_addr1, city: o.c_city, state: o.c_state, zip: o.c_zip,
            email: o.c_email, phone: o.c_phone
        };
    }

    // =====================================================
    // ORGANIZATION
    // =====================================================
    function readCustomer(customerId) {
        var c = search.lookupFields({
            type: search.Type.CUSTOMER, id: customerId,
            columns: [CUST.zdOrgId, 'companyname', 'entityid', 'billaddress1',
                      'billcity', 'billstate', 'billzipcode', 'email', 'phone']
        });
        var st = c.billstate;
        return {
            zdOrgId: c[CUST.zdOrgId], company: c.companyname, entityid: c.entityid,
            addr1: c.billaddress1, city: c.billcity,
            state: Array.isArray(st) ? (st.length ? st[0].value : '') : st,
            zip: c.billzipcode, email: c.email, phone: c.phone
        };
    }

    function getOrCreateOrg(S, customerId, cust) {
        if (S.orgCache[customerId]) return S.orgCache[customerId];

        cust = cust || readCustomer(customerId);
        if (cust.zdOrgId) {
            S.orgCache[customerId] = String(cust.zdOrgId);
            return S.orgCache[customerId];
        }

        var orgName = cust.company || cust.entityid;
        if (!orgName) throw Error('Customer ' + customerId + ' has no name');

        var org = { name: String(orgName), external_id: 'NS-CUST-' + customerId };
        var orgFields = clean({
            street_address: cust.addr1,
            city:           cust.city,
            state:          cust.state,
            zip_code:       cust.zip,
            poc_email:      cust.email,
            poc_phone:      cust.phone
        });
        if (Object.keys(orgFields).length) org.organization_fields = orgFields;

        var ep = '/api/v2/organizations/create_or_update.json';
        var res = api(S.token, 'POST', ep, { organization: org });
        var orgId = res.data.organization && res.data.organization.id;

        // Address/phone format rejected -> create with name only
        if (!orgId && org.organization_fields) {
            log.audit('Org retry without organization_fields', orgName);
            delete org.organization_fields;
            res = api(S.token, 'POST', ep, { organization: org });
            orgId = res.data.organization && res.data.organization.id;
        }

        // Name already used in Zendesk -> reuse that org
        if (!orgId && res.code === 422) {
            var f = api(S.token, 'GET',
                '/api/v2/organizations/search.json?name=' + encodeURIComponent(orgName));
            var orgs = (f.data && f.data.organizations) || [];
            if (orgs.length === 1) orgId = orgs[0].id;
        }

        if (!orgId) throw Error('Could not create/find Zendesk Organization for ' + orgName);

        saveZdId(record.Type.CUSTOMER, customerId, CUST.zdOrgId, orgId);
        log.audit('ORG CREATED', { customerId: customerId, zendeskOrgId: orgId });

        S.orgCache[customerId] = String(orgId);
        return S.orgCache[customerId];
    }

    // =====================================================
    // STATUS
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
    // ASSET TYPE: NetSuite type name -> Zendesk type ID (by name)
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
    function createParentAsset(S, a, cust) {
        if (!a.name || !a.customerId) throw Error('Asset ' + a.id + ': Name or Customer missing');

        var typeId = getAssetTypeId(S, a.assetType);
        var orgId = getOrCreateOrg(S, a.customerId, cust);

        var asset = {
            name: a.name,
            external_id: 'NS-ASSET-' + a.id,
            asset_type_id: typeId,
            status_id: getStatusId(S, a.status),
            organization_id: Number(orgId),
            manufacturer: ZD.DEFAULT_MANUFACTURER
        };
        if (a.serial) asset.serial_number = a.serial;
        if (a.itemText) asset.model = a.itemText;
        var w = toIsoDate(a.warrantyEnd);
        if (w) asset.warranty_expiration = w;
        if (ZD.CONTRACT_STATUS_KEY && a.contractStatus) {
            asset.custom_field_values = {};
            asset.custom_field_values[ZD.CONTRACT_STATUS_KEY] = a.contractStatus;
        }

        var res = api(S.token, 'POST', '/api/v2/it_asset_management/assets', { asset: asset });
        if (res.code !== 201 || !res.data.asset || !res.data.asset.id) {
            throw Error('Parent asset ' + a.id + ' create failed: HTTP ' + res.code);
        }

        var zdId = String(res.data.asset.id);
        saveZdId(ASSET_RECORD_TYPE, a.id, ASSET.zdAssetId, zdId);
        log.audit('PARENT ASSET CREATED', { netsuiteId: a.id, zendeskAssetId: zdId, zendeskOrgId: orgId });
        return zdId;
    }

    // Parent not in this batch and has no Zendesk ID -> read it and create it
    function readAsset(id) {
        var cols = ['name', ASSET.zdAssetId, ASSET.customer, ASSET.item, ASSET.serial,
                    ASSET.assetType, ASSET.status, ASSET.contractStatus, ASSET.warrantyEnd];
        var r = search.lookupFields({ type: ASSET_RECORD_TYPE, id: id, columns: cols });
        function v(f) { var x = r[f]; return Array.isArray(x) ? (x.length ? x[0].value : '') : (x || ''); }
        function t(f) { var x = r[f]; return Array.isArray(x) ? (x.length ? x[0].text : '') : (x || ''); }
        return {
            id: String(id), name: cleanName(t('name')), zdId: v(ASSET.zdAssetId),
            customerId: v(ASSET.customer), itemText: t(ASSET.item), serial: t(ASSET.serial),
            assetType: t(ASSET.assetType), status: t(ASSET.status),
            contractStatus: t(ASSET.contractStatus), warrantyEnd: t(ASSET.warrantyEnd)
        };
    }

    // =====================================================
    // CREATE CHILD (assembly_item custom object record)
    // =====================================================
    function createChild(S, c, parentZdId) {
        // Item Number: from Item, else from the asset name (e.g. "MYT-00242-01 (...)")
        var itemNo = (String(c.itemText).match(/MYT-\d{5}-\d{2}/) ||
                      String(c.name).match(/MYT-\d{5}-\d{2}/) || [''])[0];

        // Serial: Zendesk regex = MYT-12345-12-12345 (anywhere in the value)
        var rawSerial = String(c.serial || '').trim();
        var serial = /\bMYT-\d{5}-\d{2}-\d{5}\b/.test(rawSerial) ? rawSerial : '';
        if (rawSerial && !serial) log.audit('Serial skipped (format)', { asset: c.id, serial: rawSerial });

        var fields = clean({
            bot_parent:      parentZdId,
            item_number:     itemNo,
            serial_number:   serial,
            revision:        c.revision !== '' ? parseInt(c.revision, 10) : '',
            unit_cost:       c.unitCost !== '' ? parseFloat(c.unitCost) : '',
            unit_of_measure: c.unitOfMeasure,
            install_date:    toIsoDate(c.installDate)
        });
        if (isNaN(fields.revision)) delete fields.revision;
        if (isNaN(fields.unit_cost)) delete fields.unit_cost;

        var payload = {
            custom_object_record: {
                name: c.name || itemNo || ('Assembly ' + c.id),
                external_id: 'NS-ASM-' + c.id,
                custom_object_fields: fields
            }
        };

        var ep = '/api/v2/custom_objects/' + ZD.CHILD_OBJECT_KEY + '/records';
        var res = api(S.token, 'POST', ep, payload);
        var rec = res.data && res.data.custom_object_record;

        // Serial rejected by Zendesk format -> create without it
        if ((!rec || !rec.id) && res.code === 422 && fields.serial_number) {
            log.audit('Child retry without serial_number', { asset: c.id, serial: fields.serial_number });
            delete payload.custom_object_record.custom_object_fields.serial_number;
            res = api(S.token, 'POST', ep, payload);
            rec = res.data && res.data.custom_object_record;
        }
        if (!rec || !rec.id) throw Error('Child ' + c.id + ' create failed: HTTP ' + res.code);

        saveZdId(ASSET_RECORD_TYPE, c.id, ASSET.zdAssetId, rec.id);
        log.audit('CHILD CREATED', { netsuiteId: c.id, assemblyItemId: rec.id, botParent: parentZdId });
        return rec.id;
    }

    // =====================================================
    // GET INPUT DATA
    // =====================================================
    function getInputData() {
        var searchId = SEARCH_ID;
        var onlyId = TEST_ASSET_ID;

        var s = search.load({ id: searchId });

        // Test mode: only one asset
        if (onlyId) {
            s.filters.push(search.createFilter({
                name: 'internalid', operator: search.Operator.ANYOF, values: [String(onlyId)]
            }));
        }

        var byLabel = columnIndex(s.columns);

        var rows = [];
        var paged = s.runPaged({ pageSize: 1000 });
        paged.pageRanges.forEach(function (pr) {
            paged.fetch({ index: pr.index }).data.forEach(function (r) {
                var o = rowToObj(r, byLabel);
                if (!o.id) o.id = String(r.id);
                rows.push(o);
            });
        });

        log.audit('INPUT', { savedSearch: searchId, assetsToProcess: rows.length, onlyAssetId: onlyId || 'all' });
        return rows;
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

        var ok = 0, failed = 0, skipped = 0;

        // ---------- children already in Zendesk -> skip ----------
        var todo = children.filter(function (c) {
            if (c.zdId) {
                skipped++;
                log.audit('CHILD SKIPPED (already has Zendesk ID)', { netsuiteId: c.id, zendeskId: c.zdId });
                return false;
            }
            return true;
        });

        // ---------- parent Zendesk ID: reuse if it exists anywhere ----------
        // 1) parent's own row in this batch  2) parent_zd_id on a child row  3) read the parent record
        var parentZdId = (root && root.zdId) ? String(root.zdId) : '';
        if (!parentZdId) {
            children.forEach(function (c) { if (!parentZdId && c.parentZdId) parentZdId = String(c.parentZdId); });
        }
        var p = null;
        if (!parentZdId && !root) {
            p = readAsset(rootId);
            if (p.zdId) parentZdId = String(p.zdId);
        }

        if (parentZdId && root) {
            skipped++;
            log.audit('PARENT SKIPPED (already has Zendesk ID)', { netsuiteId: rootId, zendeskAssetId: parentZdId });
        }

        // Nothing to create -> stop here (no OAuth call, no Zendesk calls)
        if (parentZdId && !todo.length) {
            if (skipped) context.write({ key: 'skipped', value: skipped });
            return;
        }

        var S = { token: getToken(), orgCache: {}, statuses: null, assetTypes: null };

        // ---------- parent (only if it has no Zendesk ID anywhere) ----------
        try {
            if (!parentZdId) {
                parentZdId = root ? createParentAsset(S, root, custFrom(root))
                                  : createParentAsset(S, p, null);
                ok++;
            }
        } catch (e) {
            log.error('PARENT FAILED ' + rootId, e.message);
            context.write({ key: 'failed', value: (root ? 1 : 0) + todo.length });
            if (skipped) context.write({ key: 'skipped', value: skipped });
            return; // children need the parent
        }

        // ---------- children (only those without their own Zendesk ID) ----------
        todo.forEach(function (c) {
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
        if (skipped) context.write({ key: 'skipped', value: skipped });
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
            skippedAlreadyInZendesk: totals.skipped,
            seconds: summary.seconds,
            usage: summary.usage
        });
    }

    return { getInputData: getInputData, map: map, reduce: reduce, summarize: summarize };
});