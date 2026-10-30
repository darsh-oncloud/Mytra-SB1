/**
 * @NApiVersion 2.1
 * @NScriptType MapReduceScript
 *
 * Zendesk IT Asset Management (ITAM) test
 *   STEP 1  (CREATE_ENABLED = false): read & log assets, asset types, statuses
 *   STEP 2  (CREATE_ENABLED = true) : create the hardcoded NetSuite asset
 *
 * Zendesk assets live under /api/v2/it_asset_management/ (NOT custom objects).
 */
define(['N/https', 'N/log'], function (https, log) {

    // =============================================
    // CONFIGURATION
    // =============================================
    var BASE_URL = 'https://mytra.zendesk.com';
    var ITAM = '/api/v2/it_asset_management';
    var CLIENT_ID = 'netsuite_fsm_integration';

    var CLIENT_SECRET = '4f1beaf8b4a16f576d75f7bc4d8e77d63ac1d07a23d6f4293036c4fe62ef5779';

    // ---- STEP SWITCH ----
    var CREATE_ENABLED = false;   // false = read/log only, true = create

    var ASSET_TYPE_ID = '01M66KSY9W5XGPN4BJVST123JK';
    var ORGANIZATION_ID = 55112815315988;

    // Leave null to auto-match a status named STATUS_NAME.
    // After Step 1, you can paste the exact status id from the logs here.
    var STATUS_ID = null;
    var STATUS_NAME = 'on lease';

    var ASSET = {
        name: 'MYT-00067-00 P1 BOT ASM MYT-00067-00-00004',
        external_id: '224',
        serial_number: 'MYT-00067-00-00004',
        model: 'MYT-00067-00 P1 BOT ASM',
        warranty_expiration: '2028-04-01',
        notes: 'NetSuite Asset ID: 224. Status: On Lease. ' +
               'Lease Start: 2026-10-01. Lease End: 2027-05-31.'
    };

    // =============================================
    // HELPERS
    // =============================================
    function parse(body) {
        try { return JSON.parse(body); } catch (e) { return { raw: body }; }
    }

    // Logs long JSON in 3500-char chunks (NetSuite log detail limit ~3999)
    function logData(title, data) {
        var value = JSON.stringify(data, null, 2) || 'null';
        var size = 3500;
        var total = Math.ceil(value.length / size) || 1;
        for (var i = 0; i < total; i++) {
            log.audit(title + (total > 1 ? ' PART ' + (i + 1) + '/' + total : ''),
                value.substring(i * size, (i + 1) * size));
        }
    }

    // =============================================
    // OAUTH (client_credentials)
    // =============================================
    function getToken(scope) {
        var res = https.post({
            url: BASE_URL + '/oauth/tokens',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({
                grant_type: 'client_credentials',
                client_id: CLIENT_ID,
                client_secret: CLIENT_SECRET,
                scope: scope            // space-separated string, e.g. "read write"
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

    // =============================================
    // GENERIC REQUEST
    // =============================================
    function call(token, method, endpoint, payload) {
        var url = endpoint.indexOf('https://') === 0 ? endpoint : BASE_URL + endpoint;
        if (url.indexOf(BASE_URL + ITAM) !== 0) throw Error('Unexpected Zendesk URL: ' + url);

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
    // STEP 1a: LIST ALL ASSETS (cursor pagination)
    // =============================================
    function getAssets(token) {
        var next = ITAM + '/assets?page[size]=100';
        var all = [];
        var pages = 0;
        var match = null;

        while (next && pages < 50) {
            pages++;
            var r = call(token, 'GET', next);
            if (r.code !== 200 || !Array.isArray(r.data.assets)) return { success: false };

            r.data.assets.forEach(function (a) {
                all.push(a);
                if (String(a.external_id || '') === ASSET.external_id ||
                    a.serial_number === ASSET.serial_number) {
                    match = a;
                }
            });

            var meta = r.data.meta || {};
            var links = r.data.links || {};
            next = meta.has_more ? (links.next ||
                (meta.after_cursor ? ITAM + '/assets?page[size]=100&page[after]=' +
                    encodeURIComponent(meta.after_cursor) : null)) : null;
        }

        // Compact one-line-per-asset log, plus the full JSON of the first asset
        // so you can see every field Zendesk returns.
        logData('EXISTING ASSETS (' + all.length + ')', all.map(function (a) {
            return {
                id: a.id, name: a.name, external_id: a.external_id,
                serial_number: a.serial_number, asset_type_id: a.asset_type_id,
                status_id: a.status_id, organization_id: a.organization_id
            };
        }));
        if (all.length) logData('FIRST ASSET FULL JSON', all[0]);

        if (match) log.audit('MATCHING ASSET FOUND', { id: match.id, name: match.name });

        return { success: !next, count: all.length, existing: match };
    }

    // =============================================
    // STEP 1b: ASSET TYPES
    // =============================================
    function checkAssetType(token) {
        var r = call(token, 'GET', ITAM + '/asset_types');
        if (r.code !== 200) return false;

        var types = r.data.asset_types || [];
        logData('ASSET TYPES', types.map(function (t) {
            return { id: t.id, name: t.name, parent_id: t.parent_id };
        }));

        var found = types.some(function (t) { return String(t.id) === ASSET_TYPE_ID; });
        log.audit('ASSET TYPE CHECK', { assetTypeId: ASSET_TYPE_ID, found: found });
        return found;
    }

    // Informational only — does NOT block creation if it fails
    function logAssetFields(token) {
        var r = call(token, 'GET', ITAM + '/asset_types/' + ASSET_TYPE_ID + '/fields');
        if (r.code === 200) logData('ASSET TYPE FIELDS', r.data);
    }

    // =============================================
    // STEP 1c: STATUSES
    // =============================================
    function resolveStatus(token) {
        var r = call(token, 'GET', ITAM + '/statuses');
        if (r.code !== 200) return STATUS_ID;

        var statuses = r.data.statuses || [];
        logData('ASSET STATUSES', statuses.map(function (s) {
            return { id: s.id, name: s.name };
        }));

        if (STATUS_ID) return STATUS_ID;

        var hit = statuses.filter(function (s) {
            return String(s.name || '').toLowerCase() === STATUS_NAME;
        })[0];

        if (!hit) {
            log.error('STATUS NOT FOUND',
                'No status named "' + STATUS_NAME + '". Pick an id from ASSET STATUSES and set STATUS_ID.');
            return null;
        }
        return hit.id;
    }

    // =============================================
    // STEP 2: CREATE ASSET
    // =============================================
    function createAsset(token, statusId) {
        var payload = {
            asset: {
                name: ASSET.name,                 // required
                asset_type_id: ASSET_TYPE_ID,     // required
                status_id: statusId,              // required
                organization_id: ORGANIZATION_ID,
                external_id: ASSET.external_id,
                serial_number: ASSET.serial_number,
                model: ASSET.model,
                warranty_expiration: ASSET.warranty_expiration,
                notes: ASSET.notes
            }
        };
        logData('ASSET CREATE PAYLOAD', payload);

        var r = call(token, 'POST', ITAM + '/assets', payload);

        if ((r.code === 201 || r.code === 200) && r.data.asset && r.data.asset.id) {
            log.audit('ZENDESK ASSET CREATED', {
                zendeskAssetId: r.data.asset.id,
                netsuiteAssetId: ASSET.external_id,
                name: r.data.asset.name
            });
            return r.data.asset.id;     // save this back to NetSuite later
        }
        log.error('ASSET CREATION FAILED', { code: r.code });
        return null;
    }

    // =============================================
    // MAP REDUCE
    // =============================================
    function getInputData() { return [{ id: 224 }]; }

    function map(context) {
        log.audit('ASSET TEST STARTED', { createEnabled: CREATE_ENABLED });

        // One token for both steps. Falls back to read-only if write isn't allowed.
        var token = getToken(CREATE_ENABLED ? 'read write' : 'read');
        if (!token) return;

        // ---------- STEP 1 ----------
        var assets = getAssets(token);
        if (!assets.success) { log.error('STOPPED', 'Could not list assets'); return; }

        var typeOk = checkAssetType(token);
        logAssetFields(token);
        var statusId = resolveStatus(token);

        log.audit('DIAGNOSTIC SUMMARY', {
            existingAssets: assets.count,
            alreadyExists: !!assets.existing,
            assetTypeFound: typeOk,
            statusId: statusId
        });

        if (!CREATE_ENABLED) { log.audit('READ ONLY DONE', 'No Zendesk records changed'); return; }

        // ---------- STEP 2 ----------
        if (assets.existing) { log.audit('CREATE SKIPPED', 'Asset already exists: ' + assets.existing.id); return; }
        if (!typeOk)   { log.error('CREATE SKIPPED', 'Asset type id not found'); return; }
        if (!statusId) { log.error('CREATE SKIPPED', 'No status id'); return; }

        createAsset(token, statusId);
    }

    function summarize(summary) {
        if (summary.inputSummary.error) log.error('INPUT ERROR', summary.inputSummary.error);
        summary.mapSummary.errors.iterator().each(function (key, err) {
            log.error('MAP ERROR ' + key, err);
            return true;
        });
        log.audit('ASSET TEST FINISHED', { usage: summary.usage, seconds: summary.seconds });
    }

    return { getInputData: getInputData, map: map, summarize: summarize };
});