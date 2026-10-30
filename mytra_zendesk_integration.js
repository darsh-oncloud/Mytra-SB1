/**
 * @NApiVersion 2.1
 * @NScriptType MapReduceScript
 *
 * Zendesk Asset as a CUSTOM OBJECT
 *   STEP 1 (CREATE_ENABLED = false): find the Asset custom object, log its
 *          fields and all existing asset records. Nothing is changed.
 *   STEP 2 (CREATE_ENABLED = true) : create the hardcoded NetSuite asset record.
 *
 * Uses scopes your OAuth client already has: custom_objects:read / custom_objects:write
 */
define(['N/https', 'N/log'], function (https, log) {

    // =============================================
    // CONFIGURATION
    // =============================================
    var BASE_URL = 'https://mytra.zendesk.com';
    var CO = '/api/v2/custom_objects';
    var CLIENT_ID = 'netsuite_fsm_integration';
    var CLIENT_SECRET = '4f1beaf8b4a16f576d75f7bc4d8e77d63ac1d07a23d6f4293036c4fe62ef5779';

    // ---- STEP SWITCH ----
    var CREATE_ENABLED = false;   // false = read/log only, true = create

    // Leave null to auto-detect (first custom object with "asset" in key/title).
    // After Step 1, paste the exact key from the "ALL CUSTOM OBJECTS" log here.
    var OBJECT_KEY = 'ezo_cmms_assets';

    var ORGANIZATION_ID = 55112815315988;   // Baxter Healthcare Corporation

    var ASSET = {
        name: 'MYT-00067-00 P1 BOT ASM MYT-00067-00-00004',
        external_id: '224'          // NetSuite asset internal ID
    };

    // Field values for the asset record.
    // After Step 1, replace the LEFT side with the real field keys from the
    // "ASSET OBJECT FIELDS" log. Fields whose key doesn't exist on the
    // object are skipped automatically, so it's safe to run as-is.
    // Mapped to the real fields of ezo_cmms_assets (from the Step 1 log).
    // This object has no lease / warranty / organization fields,
    // so those details go into "description".
    var FIELD_VALUES = {
        asset_name: 'MYT-00067-00 P1 BOT ASM MYT-00067-00-00004',
        identifier: 'MYT-00067-00-00004',               // serial number
        product_model_number: 'MYT-00067-00 P1 BOT ASM', // NetSuite item
        state: 'On Lease',                               // NetSuite status
        assigned_to: 'Baxter Healthcare Corporation',    // customer
        quantity: 1,
        description:
            'NetSuite Asset ID: 224. ' +
            'Customer: Baxter Healthcare Corporation (Zendesk Org ' + ORGANIZATION_ID + '). ' +
            'Lease: 2026-10-01 to 2027-05-31. ' +
            'Warranty: 2026-10-01 to 2028-04-01 (under warranty).'
    };

    // =============================================
    // HELPERS
    // =============================================
    function parse(body) {
        try { return JSON.parse(body); } catch (e) { return { raw: body }; }
    }

    function logData(title, data) {
        var value = JSON.stringify(data, null, 2) || 'null';
        var size = 3500;
        var total = Math.ceil(value.length / size) || 1;
        for (var i = 0; i < total; i++) {
            log.audit(title + (total > 1 ? ' PART ' + (i + 1) + '/' + total : ''),
                value.substring(i * size, (i + 1) * size));
        }
    }

    function getToken(scope) {
        var res = https.post({
            url: BASE_URL + '/oauth/tokens',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({
                grant_type: 'client_credentials',
                client_id: CLIENT_ID,
                client_secret: CLIENT_SECRET,
                scope: scope
            })
        });
        var data = parse(res.body);
        if (Number(res.code) !== 200 || !data.access_token) {
            log.error('OAUTH FAILED', {
                requestedScope: scope, httpCode: res.code,
                error: data.error, description: data.error_description
            });
            return null;
        }
        log.audit('OAUTH SUCCESS', { requestedScope: scope, grantedScope: data.scope });
        return data.access_token;
    }

    function call(token, method, endpoint, payload) {
        var url = endpoint.indexOf('https://') === 0 ? endpoint : BASE_URL + endpoint;
        var opts = {
            url: url,
            headers: {
                Authorization: 'Bearer ' + token,
                Accept: 'application/json',
                'Content-Type': 'application/json'
            }
        };
        if (payload) opts.body = JSON.stringify(payload);

        var res = method === 'POST' ? https.post(opts) : https.get(opts);
        var data = parse(res.body);
        var code = Number(res.code);

        log.audit('API ' + method, { endpoint: endpoint, httpCode: code });
        if (code >= 400) logData('API ' + method + ' ERROR ' + code, { endpoint: endpoint, response: data });
        return { code: code, data: data };
    }

    // =============================================
    // STEP 1a: LIST ALL CUSTOM OBJECTS, PICK THE ASSET ONE
    // =============================================
    function findAssetObject(token) {
        var r = call(token, 'GET', CO);
        if (r.code !== 200) return null;

        var objects = r.data.custom_objects || [];
        logData('ALL CUSTOM OBJECTS (' + objects.length + ')', objects.map(function (o) {
            return { key: o.key, title: o.title, title_pluralized: o.title_pluralized };
        }));

        if (OBJECT_KEY) {
            var exact = objects.filter(function (o) { return o.key === OBJECT_KEY; })[0];
            if (!exact) { log.error('OBJECT KEY NOT FOUND', OBJECT_KEY); return null; }
            return exact.key;
        }

        var hit = objects.filter(function (o) {
            return ((o.key || '') + ' ' + (o.title || '')).toLowerCase().indexOf('asset') !== -1;
        })[0];

        if (!hit) {
            log.error('ASSET OBJECT NOT FOUND',
                'No object with "asset" in its key/title. Set OBJECT_KEY from the list above.');
            return null;
        }
        log.audit('ASSET OBJECT SELECTED', { key: hit.key, title: hit.title });
        return hit.key;
    }

    // =============================================
    // STEP 1b: FIELDS OF THE ASSET OBJECT
    // =============================================
    function getFields(token, key) {
        var r = call(token, 'GET', CO + '/' + encodeURIComponent(key) + '/fields');
        if (r.code !== 200) return [];

        var fields = r.data.custom_object_fields || [];
        logData('ASSET OBJECT FIELDS (' + fields.length + ')', fields.map(function (f) {
            return {
                key: f.key, title: f.title, type: f.type,
                required: f.required, active: f.active,
                relationship_target_type: f.relationship_target_type,
                options: (f.custom_field_options || []).map(function (o) {
                    return { name: o.name, value: o.value };
                })
            };
        }));
        return fields;
    }

    // =============================================
    // STEP 1c: ALL EXISTING ASSET RECORDS (cursor pagination)
    // =============================================
    function getRecords(token, key) {
        var next = CO + '/' + encodeURIComponent(key) + '/records?page%5Bsize%5D=100';
        var all = [];
        var pages = 0;

        while (next && pages < 50) {
            pages++;
            var r = call(token, 'GET', next);
            if (r.code !== 200) return { success: false };

            (r.data.custom_object_records || []).forEach(function (rec) { all.push(rec); });

            var meta = r.data.meta || {};
            var links = r.data.links || {};
            next = meta.has_more ? (links.next || null) : null;
        }

        logData('EXISTING ASSET RECORDS (' + all.length + ')', all.map(function (rec) {
            return {
                id: rec.id, name: rec.name, external_id: rec.external_id,
                fields: rec.custom_object_fields
            };
        }));
        if (all.length) logData('FIRST RECORD FULL JSON', all[0]);

        var match = all.filter(function (rec) {
            return String(rec.external_id || '') === ASSET.external_id;
        })[0] || null;
        if (match) log.audit('MATCHING ASSET FOUND', { id: match.id, name: match.name });

        return { success: !next, count: all.length, existing: match };
    }

    // =============================================
    // STEP 2: CREATE THE ASSET RECORD
    // =============================================
    function createRecord(token, key, fields) {
        var validKeys = {};
        fields.forEach(function (f) { validKeys[f.key] = true; });

        var values = {};
        var skipped = [];
        Object.keys(FIELD_VALUES).forEach(function (k) {
            if (validKeys[k]) values[k] = FIELD_VALUES[k];
            else skipped.push(k);
        });
        if (skipped.length) {
            log.audit('FIELDS SKIPPED (key not on object)', skipped.join(', '));
        }

        var payload = {
            custom_object_record: {
                name: ASSET.name,
                external_id: ASSET.external_id,
                custom_object_fields: values
            }
        };
        logData('ASSET CREATE PAYLOAD', payload);

        var r = call(token, 'POST', CO + '/' + encodeURIComponent(key) + '/records', payload);
        var rec = r.data.custom_object_record;

        if ((r.code === 201 || r.code === 200) && rec && rec.id) {
            log.audit('ZENDESK ASSET CREATED', {
                zendeskRecordId: rec.id,
                netsuiteAssetId: rec.external_id,
                name: rec.name,
                createdAt: rec.created_at,
                url: rec.url
            });
            // Everything Zendesk saved, including all field values
            logData('CREATED RECORD FULL RESPONSE', r.data);
            return rec.id;
        }
        log.error('ASSET CREATION FAILED', { code: r.code });
        logData('CREATE FAILED RESPONSE', r.data);
        return null;
    }

    // =============================================
    // MAP REDUCE
    // =============================================
    function getInputData() { return [{ id: 224 }]; }

    function map(context) {
        log.audit('ASSET TEST STARTED', { createEnabled: CREATE_ENABLED });

        var token = getToken(CREATE_ENABLED
            ? 'custom_objects:read custom_objects:write'
            : 'custom_objects:read');
        if (!token) return;

        // ---------- STEP 1 ----------
        var key = findAssetObject(token);
        if (!key) return;

        var fields = getFields(token, key);
        var records = getRecords(token, key);
        if (!records.success) { log.error('STOPPED', 'Could not list asset records'); return; }

        log.audit('DIAGNOSTIC SUMMARY', {
            objectKey: key,
            fieldCount: fields.length,
            existingRecords: records.count,
            alreadyExists: !!records.existing
        });

        if (!CREATE_ENABLED) { log.audit('READ ONLY DONE', 'No Zendesk records changed'); return; }

        // ---------- STEP 2 ----------
        if (records.existing) {
            log.audit('CREATE SKIPPED', 'Asset already exists: ' + records.existing.id);
            return;
        }
        createRecord(token, key, fields);
    }

    function summarize(summary) {
        if (summary.inputSummary.error) log.error('INPUT ERROR', summary.inputSummary.error);
        summary.mapSummary.errors.iterator().each(function (k, err) {
            log.error('MAP ERROR ' + k, err);
            return true;
        });
        log.audit('ASSET TEST FINISHED', { usage: summary.usage, seconds: summary.seconds });
    }

    return { getInputData: getInputData, map: map, summarize: summarize };
});