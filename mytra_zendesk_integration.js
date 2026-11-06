/**
 * @NApiVersion 2.1
 * @NScriptType MapReduceScript
 * @NModuleScope SameAccount
 *
 * TEST / DISCOVERY - Zendesk (no UI access needed)
 *
 * Logs everything you can send values to in Zendesk:
 *   - all custom objects
 *   - assembly_item fields (key, type, regex, lookup target)
 *   - a few existing assembly_item records
 *   - asset types, asset statuses, asset custom fields
 *   - organization fields
 *   - parent Bot asset check
 *   - (optional) create ONE test assembly_item linked to the parent Bot
 *
 * HOW TO RUN
 *   1. Set CONFIG below (secret, PARENT_ASSET_ID, CREATE_TEST)
 *   2. Script Deployment -> Save and Execute
 *   3. Read results: Script Deployment -> Execution Log
 *      (titles start with the step name, e.g. "3_ASSEMBLY_FIELDS")
 *
 *   First run with CREATE_TEST = false (read only).
 *   Then set CREATE_TEST = true to create 1 test child record.
 */
define(['N/https', 'N/runtime', 'N/log'],
function (https, runtime, log) {

    // =====================================================
    // CONFIG
    // =====================================================
    var CONFIG = {
        BASE_URL: 'https://mytra.zendesk.com',
        CLIENT_ID: 'netsuite_fsm_integration',
        SECRET_PARAM: 'custscript_zd_client_secret',
        CLIENT_SECRET_FALLBACK: '4f1beaf8b4a16f576d75f7bc4d8e77d63ac1d07a23d6f4293036c4fe62ef5779',
        SCOPE: 'read write',

        OBJECT_KEY: 'assembly_item',
        PARENT_FIELD: 'bot_parent',

        // Parent Bot asset in Zendesk ("Dhruv Test" from earlier logs)
        PARENT_ASSET_ID: '01M6F4XW9XGXBPA21VX2TC03D3',

        // false = read only | true = also create 1 test child record
        CREATE_TEST: false
    };

    // =====================================================
    // HELPERS
    // =====================================================
    function parse(body) {
        try { return JSON.parse(body); } catch (e) { return { raw: body }; }
    }

    // NetSuite log detail max ~3999 chars -> split long output
    function logBig(title, obj) {
        var s = typeof obj === 'string' ? obj : JSON.stringify(obj, null, 1);
        var size = 3800;
        var parts = Math.ceil(s.length / size) || 1;
        for (var i = 0; i < parts; i++) {
            log.audit(title + ' PART ' + (i + 1) + '/' + parts, s.substr(i * size, size));
        }
    }

    function getToken() {
        var secret = runtime.getCurrentScript()
            .getParameter({ name: CONFIG.SECRET_PARAM }) || CONFIG.CLIENT_SECRET_FALLBACK;

        var res = https.post({
            url: CONFIG.BASE_URL + '/oauth/tokens',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({
                grant_type: 'client_credentials',
                client_id: CONFIG.CLIENT_ID,
                client_secret: secret,
                scope: CONFIG.SCOPE
            })
        });

        var data = parse(res.body);
        if (Number(res.code) !== 200 || !data.access_token) {
            throw Error('OAuth failed: ' + res.code + ' ' + JSON.stringify(data));
        }
        return data.access_token;
    }

    function api(token, method, endpoint, payload) {
        var opts = {
            url: CONFIG.BASE_URL + endpoint,
            headers: {
                Authorization: 'Bearer ' + token,
                Accept: 'application/json',
                'Content-Type': 'application/json'
            }
        };
        if (payload) opts.body = JSON.stringify(payload);

        var res = method === 'POST' ? https.post(opts) : https.get(opts);
        return { endpoint: endpoint, httpCode: Number(res.code), data: parse(res.body) };
    }

    // =====================================================
    // STEPS (each runs as its own map entry)
    // =====================================================
    var KEY = CONFIG.OBJECT_KEY;

    var STEPS = {

        '1_ALL_CUSTOM_OBJECTS': function (t) {
            var r = api(t, 'GET', '/api/v2/custom_objects');
            var list = (r.data.custom_objects || []).map(function (o) {
                return { key: o.key, title: o.title, title_pluralized: o.title_pluralized };
            });
            return { httpCode: r.httpCode, count: list.length, objects: list.length ? list : r.data };
        },

        '2_ASSEMBLY_OBJECT': function (t) {
            var r = api(t, 'GET', '/api/v2/custom_objects/' + KEY);
            return { httpCode: r.httpCode, exists: r.httpCode === 200, data: r.data };
        },

        '3_ASSEMBLY_FIELDS': function (t) {
            var r = api(t, 'GET', '/api/v2/custom_objects/' + KEY + '/fields');
            var f = (r.data.custom_object_fields || []).map(function (x) {
                return {
                    key: x.key,
                    title: x.title,
                    type: x.type,
                    active: x.active,
                    required: x.required,
                    regex: x.regexp_for_validation || null,
                    lookup_target: x.relationship_target_type || null,
                    options: x.custom_field_options || null
                };
            });
            return { httpCode: r.httpCode, fields: f.length ? f : r.data };
        },

        '4_ASSEMBLY_RECORDS_SAMPLE': function (t) {
            var r = api(t, 'GET', '/api/v2/custom_objects/' + KEY + '/records?page[size]=5');
            return { httpCode: r.httpCode, records: r.data.custom_object_records || r.data };
        },

        '5_ASSET_TYPES': function (t) {
            var r = api(t, 'GET', '/api/v2/it_asset_management/asset_types');
            var list = (r.data.asset_types || []).map(function (x) {
                return {
                    id: x.id, name: x.name, parent_id: x.parent_id,
                    depth: x.hierarchy_depth, field_keys: x.field_keys
                };
            });
            return { httpCode: r.httpCode, types: list.length ? list : r.data };
        },

        '6_ASSET_STATUSES': function (t) {
            var r = api(t, 'GET', '/api/v2/it_asset_management/statuses');
            var list = (r.data.statuses || []).map(function (x) {
                return { id: x.id, name: x.name, external_id: x.external_id, category: x.category };
            });
            return { httpCode: r.httpCode, statuses: list.length ? list : r.data };
        },

        // Best effort: endpoint may not exist on every plan -> logs the httpCode either way
        '7_ASSET_CUSTOM_FIELDS': function (t) {
            var r = api(t, 'GET', '/api/v2/it_asset_management/fields');
            return { httpCode: r.httpCode, data: r.data };
        },

        '8_ORGANIZATION_FIELDS': function (t) {
            var r = api(t, 'GET', '/api/v2/organization_fields');
            var list = (r.data.organization_fields || []).map(function (x) {
                return { key: x.key, title: x.title, type: x.type, active: x.active };
            });
            return { httpCode: r.httpCode, fields: list.length ? list : r.data };
        },

        '9_PARENT_ASSET': function (t) {
            var r = api(t, 'GET', '/api/v2/it_asset_management/assets/' + CONFIG.PARENT_ASSET_ID);
            var a = r.data.asset || r.data;
            return {
                httpCode: r.httpCode, exists: r.httpCode === 200,
                id: a.id, name: a.name, asset_type_id: a.asset_type_id,
                organization_id: a.organization_id
            };
        },

        '10_CREATE_TEST_CHILD': function (t) {
            var stamp = new Date().getTime();
            var fields = {};
            fields[CONFIG.PARENT_FIELD] = CONFIG.PARENT_ASSET_ID;

            var payload = {
                custom_object_record: {
                    name: 'NS TEST Assembly ' + stamp,
                    external_id: 'NS-TEST-ASM-' + stamp,
                    custom_object_fields: fields
                }
            };

            var c = api(t, 'POST', '/api/v2/custom_objects/' + KEY + '/records', payload);
            var rec = c.data && c.data.custom_object_record;

            if (!rec || !rec.id) {
                return { result: 'CREATE FAILED', httpCode: c.httpCode, payload: payload, response: c.data };
            }

            var b = api(t, 'GET', '/api/v2/custom_objects/' + KEY + '/records/' + rec.id);
            var back = (b.data && b.data.custom_object_record) || b.data;
            var linked = back && back.custom_object_fields &&
                String(back.custom_object_fields[CONFIG.PARENT_FIELD] || '') ===
                String(CONFIG.PARENT_ASSET_ID);

            return {
                result: linked ? 'SUCCESS - child linked to parent'
                               : 'CREATED but bot_parent not saved as expected',
                childRecordId: rec.id,
                httpCode: c.httpCode,
                payload: payload,
                readBack: back
            };
        }
    };

    // =====================================================
    // MAP / REDUCE
    // =====================================================
    function getInputData() {
        var names = Object.keys(STEPS).filter(function (n) {
            return n !== '10_CREATE_TEST_CHILD' || CONFIG.CREATE_TEST;
        });
        log.audit('DISCOVERY STARTED', { steps: names, createTest: CONFIG.CREATE_TEST });
        return names;
    }

    function map(context) {
        var step = context.value;
        var out;
        try {
            var token = getToken();
            out = STEPS[step](token);
        } catch (e) {
            out = { error: e.message, stack: e.stack };
        }
        logBig(step, out);
        context.write({ key: step, value: JSON.stringify({ httpCode: out.httpCode, result: out.result || '', error: out.error || '' }) });
    }

    function summarize(summary) {
        var rows = [];
        summary.output.iterator().each(function (k, v) {
            rows.push(k + ' -> ' + v);
            return true;
        });
        rows.sort(function (a, b) { return parseInt(a, 10) - parseInt(b, 10); });

        summary.mapSummary.errors.iterator().each(function (k, e) {
            log.error('MAP ERROR ' + k, e);
            return true;
        });

        logBig('DISCOVERY SUMMARY', rows.join('\n'));
    }

    return {
        getInputData: getInputData,
        map: map,
        summarize: summarize
    };
});