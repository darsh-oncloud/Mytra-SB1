/**
 * @NApiVersion 2.1
 * @NScriptType MapReduceScript
 * @NModuleScope SameAccount
 *
 * FIELD DISCOVERY (READ-ONLY) - NetSuite <-> Zendesk
 *
 * Creates NOTHING in Zendesk and changes NOTHING in NetSuite.
 * It only reads field definitions and sample values, then:
 *   1. writes one CSV to the File Cabinet (FOLDER_ID)   -> open it in Excel
 *   2. logs every section as Audit lines (Execution Log)
 *
 * Sections:
 *   ZD_ORG      Zendesk Organization fields          -> search label org. / org_cf.
 *   ZD_ASSET    Zendesk ITAM Asset fields per type   -> search label asset. / asset_cf.
 *   ZD_ASM      Zendesk assembly_item fields         -> search label asm.
 *   NS_ASSET    NetSuite Field Service Asset fields (child + parent values)
 *   NS_CUSTOMER NetSuite Customer fields (join CUSTRECORD_NX_ASSET_CUSTOMER)
 *
 * No script parameters: set the constants below.
 */
define(['N/https', 'N/record', 'N/file', 'N/log'],
function (https, record, file, log) {

    // =====================================================
    // CONFIG
    // =====================================================
    var ZD = {
        BASE_URL: 'https://mytra.zendesk.com',
        CLIENT_ID: 'netsuite_fsm_integration',
        CLIENT_SECRET: '4f1beaf8b4a16f576d75f7bc4d8e77d63ac1d07a23d6f4293036c4fe62ef5779',
        SCOPE: 'read',
        CHILD_OBJECT_KEY: 'assembly_item'
    };

    var ASSET_RECORD_TYPE = 'customrecord_nx_asset';
    var ASSET_CUSTOMER_FIELD = 'custrecord_nx_asset_customer';
    var ASSET_ZD_ID_FIELD = 'custrecord_asset_id';
    var SAMPLE_ASSET_ID = '232';     // a CHILD asset (has a parent) - parent is read too
    var FOLDER_ID = '';              // File Cabinet folder internal ID for the CSV ('' = logs only)

    // Fields the sync script sets itself (do not map)
    var SET_BY_SCRIPT = {
        org:   ['external_id', 'id'],
        asset: ['external_id', 'organization_id', 'id', 'asset_type_id', 'status_id'],
        asm:   ['external_id', 'bot_parent', 'id']
    };
    var ORG_STANDARD = ['name', 'details', 'notes', 'domain_names', 'tags', 'group_id',
                        'shared_tickets', 'shared_comments', 'external_id'];
    var ASSET_STANDARD = ['name', 'asset_tag', 'serial_number', 'manufacturer', 'model',
                          'purchase_date', 'purchase_cost', 'vendor', 'warranty_expiration',
                          'notes', 'user_id', 'location_id', 'status_id', 'asset_type_id',
                          'organization_id', 'external_id'];

    var COLS = ['Section', 'Group', 'Key / Field ID', 'Title / Label', 'Type', 'Kind / Info',
                'Search label', 'Value (child)', 'Value (parent)'];

    // =====================================================
    // HELPERS
    // =====================================================
    function parse(b) { try { return JSON.parse(b); } catch (e) { return { raw: b }; } }

    function token() {
        var s = ZD.CLIENT_SECRET;
        if (!s || s.indexOf('PASTE_') === 0) throw Error('Set ZD.CLIENT_SECRET at the top of the script');
        var res = https.post({
            url: ZD.BASE_URL + '/oauth/tokens',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({ grant_type: 'client_credentials', client_id: ZD.CLIENT_ID,
                                   client_secret: s, scope: ZD.SCOPE })
        });
        var d = parse(res.body);
        if (Number(res.code) !== 200 || !d.access_token) throw Error('OAuth failed: ' + res.code + ' ' + res.body);
        return d.access_token;
    }

    function zget(tok, ep) {
        var res = https.get({
            url: ZD.BASE_URL + ep,
            headers: { Authorization: 'Bearer ' + tok, Accept: 'application/json' }
        });
        var out = { code: Number(res.code), data: parse(res.body) };
        if (out.code !== 200) log.error('Zendesk GET ' + ep, { httpCode: out.code, response: out.data });
        return out;
    }

    function firstArray(d, keys) {
        for (var i = 0; i < keys.length; i++) if (d && Array.isArray(d[keys[i]])) return d[keys[i]];
        return [];
    }

    function suffix(type) {
        var t = String(type || '').toLowerCase();
        if (t === 'date') return '|date';
        if (t === 'decimal' || t === 'currency' || t === 'number') return '|number';
        if (t === 'integer') return '|integer';
        if (t === 'checkbox' || t === 'boolean') return '|bool';
        if (t === 'multiselect' || t === 'tagger_multi' || t === 'tags' || t === 'array') return '|list';
        return '';
    }

    function stripStd(k) { return String(k || '').replace(/^standard::/, ''); }

    function labelFor(pStd, pCf, key, type, isStd, scriptSet) {
        if (scriptSet.indexOf(key) >= 0) return '(set by script - do not map)';
        if (String(type).toLowerCase() === 'lookup') return '(lookup - do not map)';
        return (isStd ? pStd : pCf) + '.' + key + suffix(type);
    }

    function row(section, group, key, title, type, info, label, v1, v2) {
        return { s: section, g: group || '', k: key || '', t: title || '', ty: type || '',
                 i: info || '', l: label || '', v1: v1 == null ? '' : String(v1),
                 v2: v2 == null ? '' : String(v2) };
    }

    function fieldInfo(rec, id) {
        var f = null, v = '', t = '';
        try { f = rec.getField({ fieldId: id }); } catch (e) { f = null; }
        try { v = rec.getValue({ fieldId: id }); } catch (e) { v = ''; }
        try { t = rec.getText({ fieldId: id }); } catch (e) { t = ''; }
        if (Array.isArray(v)) v = v.join(', ');
        if (Array.isArray(t)) t = t.join(', ');
        var shown = (t && String(t) !== String(v)) ? t + ' [' + v + ']' : v;
        return { label: f ? f.label : '', type: f ? f.type : '', value: shown == null ? '' : String(shown) };
    }

    function interesting(id) {
        return !/^(_|nsapi|ns_|nlloc|nlsub|nldept|nlclass|wfinstances|sys_|baserecordtype|rectype|externalid_|entryformquerystring|customwhence|linenumber|nsbrowserenv|selectedtab|submitnext|templatestored|type$|id$|_eml|ntype|wfvalidation)/i.test(id);
    }

    function loadAssets() {
        var child = record.load({ type: ASSET_RECORD_TYPE, id: SAMPLE_ASSET_ID });
        var parentId = '', parent = null;
        try { parentId = child.getValue({ fieldId: 'parent' }) || ''; } catch (e) { parentId = ''; }
        if (parentId) {
            try { parent = record.load({ type: ASSET_RECORD_TYPE, id: parentId }); } catch (e) { parent = null; }
        }
        return { child: child, parent: parent, parentId: String(parentId) };
    }

    // =====================================================
    // SECTIONS
    // =====================================================
    function zdOrg() {
        var tok = token(), rows = [];
        ORG_STANDARD.forEach(function (k) {
            var t = (k === 'domain_names' || k === 'tags') ? 'array' : (k.indexOf('shared') === 0 ? 'checkbox' : 'text');
            rows.push(row('ZD_ORG', 'Organization', k, k, t, 'standard',
                          labelFor('org', 'org_cf', k, t, true, SET_BY_SCRIPT.org)));
        });
        var of = zget(tok, '/api/v2/organization_fields.json');
        firstArray(of.data, ['organization_fields']).forEach(function (f) {
            rows.push(row('ZD_ORG', 'Organization', f.key, f.title, f.type,
                          f.active === false ? 'custom (INACTIVE)' : 'custom',
                          labelFor('org', 'org_cf', f.key, f.type, false, SET_BY_SCRIPT.org)));
        });
        return rows;
    }

    function zdAsset() {
        var tok = token(), rows = [];

        // sample asset to tell standard vs custom: parent's Zendesk asset, else first asset
        var sample = null;
        try {
            var a = loadAssets();
            var pz = a.parent ? a.parent.getValue({ fieldId: ASSET_ZD_ID_FIELD }) : '';
            if (pz) {
                var s1 = zget(tok, '/api/v2/it_asset_management/assets/' + encodeURIComponent(pz));
                sample = s1.data && s1.data.asset;
            }
        } catch (e) { sample = null; }
        if (!sample) {
            var s2 = zget(tok, '/api/v2/it_asset_management/assets?page[size]=1');
            sample = firstArray(s2.data, ['assets'])[0] || null;
        }
        var sampleTop = sample ? Object.keys(sample) : [];
        if (sample) log.audit('ZD_ASSET sample asset (raw)', JSON.stringify(sample).slice(0, 3900));

        var at = zget(tok, '/api/v2/it_asset_management/asset_types');
        firstArray(at.data, ['asset_types']).forEach(function (t) {
            var fr = zget(tok, '/api/v2/it_asset_management/asset_types/' + encodeURIComponent(t.id) + '/fields');
            var fields = firstArray(fr.data, ['fields', 'asset_fields', 'asset_type_fields', 'custom_object_fields']);
            if (!fields.length) {
                rows.push(row('ZD_ASSET', t.name + ' (' + t.id + ')', '', '', '', 'no fields returned (HTTP ' + fr.code + ')', ''));
            }
            fields.forEach(function (f) {
                var key = stripStd(f.key);
                var isStd = String(f.key).indexOf('standard::') === 0 || f.system === true ||
                            ASSET_STANDARD.indexOf(key) >= 0 || sampleTop.indexOf(key) >= 0;
                var info = (isStd ? 'standard' : 'custom') + (f.active === false ? ' (INACTIVE)' : '');
                if (f.custom_field_options && f.custom_field_options.length) {
                    info += ' | options: ' + f.custom_field_options.map(function (o) { return o.value; }).join(', ');
                }
                rows.push(row('ZD_ASSET', t.name + ' (' + t.id + ')', key, f.title || f.name, f.type, info,
                              labelFor('asset', 'asset_cf', key, f.type, isStd, SET_BY_SCRIPT.asset)));
            });
        });

        // statuses (for reference)
        var st = zget(tok, '/api/v2/it_asset_management/statuses');
        firstArray(st.data, ['statuses']).forEach(function (s) {
            rows.push(row('ZD_ASSET', 'Statuses', s.id, s.name, 'status', 'map NetSuite status text to this name', 'asset.status'));
        });
        return rows;
    }

    function zdAsm() {
        var tok = token(), rows = [];
        var cf = zget(tok, '/api/v2/custom_objects/' + ZD.CHILD_OBJECT_KEY + '/fields?include_standard_fields=true');
        firstArray(cf.data, ['custom_object_fields']).forEach(function (f) {
            var key = stripStd(f.key);
            var info = f.regexp_for_validation ? 'regex: ' + f.regexp_for_validation : '';
            if (f.custom_field_options && f.custom_field_options.length) {
                info = 'options: ' + f.custom_field_options.map(function (o) { return o.value; }).join(', ');
            }
            var label = key === 'name' ? 'asm.name' : labelFor('asm', 'asm', key, f.type, true, SET_BY_SCRIPT.asm);
            rows.push(row('ZD_ASM', ZD.CHILD_OBJECT_KEY, key, f.title, f.type, info, label));
        });
        return rows;
    }

    function nsAsset() {
        var a = loadAssets(), rows = [];
        var ids = a.child.getFields().filter(interesting);
        if (a.parent) a.parent.getFields().filter(interesting).forEach(function (id) { if (ids.indexOf(id) < 0) ids.push(id); });
        ids.sort().forEach(function (id) {
            var c = fieldInfo(a.child, id);
            var p = a.parent ? fieldInfo(a.parent, id) : { label: '', type: '', value: '' };
            rows.push(row('NS_ASSET', 'child ' + SAMPLE_ASSET_ID + ' / parent ' + (a.parentId || '-'),
                          id, c.label || p.label, c.type || p.type, 'search column name: "' + id + '"', '',
                          c.value, p.value));
        });
        return rows;
    }

    function nsCustomer() {
        var a = loadAssets(), rows = [];
        var custId = (a.parent && a.parent.getValue({ fieldId: ASSET_CUSTOMER_FIELD })) ||
                     a.child.getValue({ fieldId: ASSET_CUSTOMER_FIELD });
        if (!custId) return [row('NS_CUSTOMER', '', '', '', '', 'asset has no customer', '')];
        var cust = record.load({ type: record.Type.CUSTOMER, id: custId });
        cust.getFields().filter(interesting).sort().forEach(function (id) {
            var c = fieldInfo(cust, id);
            if (!c.label && !c.value) return;
            rows.push(row('NS_CUSTOMER', 'customer ' + custId, id, c.label, c.type,
                          'join: "CUSTRECORD_NX_ASSET_CUSTOMER"', '', c.value));
        });
        return rows;
    }

    var SECTIONS = { ZD_ORG: zdOrg, ZD_ASSET: zdAsset, ZD_ASM: zdAsm, NS_ASSET: nsAsset, NS_CUSTOMER: nsCustomer };
    var ORDER = ['ZD_ORG', 'ZD_ASSET', 'ZD_ASM', 'NS_ASSET', 'NS_CUSTOMER'];

    // =====================================================
    // MAP / REDUCE
    // =====================================================
    function getInputData() {
        return ORDER;
    }

    function map(context) {
        var section = context.value;
        var rows;
        try {
            rows = SECTIONS[section]();
        } catch (e) {
            log.error(section + ' FAILED', e.message);
            rows = [row(section, 'ERROR', '', '', '', e.message, '')];
        }
        rows.forEach(function (r, i) {
            r.n = i;
            context.write({ key: section, value: r });
        });
    }

    function summarize(summary) {
        summary.inputSummary.error && log.error('INPUT ERROR', summary.inputSummary.error);
        summary.mapSummary.errors.iterator().each(function (k, e) { log.error('MAP ERROR ' + k, e); return true; });

        var bySection = {};
        summary.output.iterator().each(function (k, v) {
            (bySection[k] = bySection[k] || []).push(JSON.parse(v));
            return true;
        });

        var all = [];
        ORDER.forEach(function (sec) {
            var rows = (bySection[sec] || []).sort(function (a, b) { return a.n - b.n; });
            all = all.concat(rows);

            // readable log, chunked (Execution Log detail max ~3999 chars)
            var lines = rows.map(function (r) {
                return [r.g, r.k, r.t, r.ty, r.l || r.i, r.v1, r.v2].filter(function (x) { return x !== ''; }).join(' | ');
            });
            var chunk = '', part = 1;
            lines.forEach(function (ln) {
                if ((chunk + ln).length > 3800) {
                    log.audit(sec + ' (' + rows.length + ' rows) part ' + part++, chunk);
                    chunk = '';
                }
                chunk += ln + '\n';
            });
            if (chunk) log.audit(sec + ' (' + rows.length + ' rows) part ' + part, chunk);
        });

        if (FOLDER_ID) {
            var csvEsc = function (v) { return '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"'; };
            var csv = COLS.map(csvEsc).join(',') + '\n' + all.map(function (r) {
                return [r.s, r.g, r.k, r.t, r.ty, r.i, r.l, r.v1, r.v2].map(csvEsc).join(',');
            }).join('\n');
            var f = file.create({
                name: 'zendesk_field_discovery_' + new Date().getTime() + '.csv',
                fileType: file.Type.CSV, contents: csv, folder: Number(FOLDER_ID)
            });
            var fileId = f.save();
            log.audit('DISCOVERY CSV SAVED', { fileId: fileId, rows: all.length });
        } else {
            log.audit('DISCOVERY DONE', { rows: all.length, note: 'Set FOLDER_ID to also get a CSV file' });
        }
    }

    // no reduce stage: map output goes straight to summarize
    return { getInputData: getInputData, map: map, summarize: summarize };
});