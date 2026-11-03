/**
 * @NApiVersion 2.1
 * @NScriptType MapReduceScript
 *
 * Creates a hardcoded asset in Zendesk IT Asset Management:
 *   POST /api/v2/it_asset_management/assets
 *
 * Needs the general "write" scope on the OAuth client
 * (there is no asset-specific scope).
 */
define(['N/https', 'N/log'], function(https, log) {

    var BASE_URL = 'https://mytra.zendesk.com';
    var CLIENT_ID = 'netsuite_fsm_integration';
    var CLIENT_SECRET = '4f1beaf8b4a16f576d75f7bc4d8e77d63ac1d07a23d6f4293036c4fe62ef5779';

    // Tried in order until one is allowed on the OAuth client
    var READ_SCOPES  = ['read', 'custom_objects:read'];
    var WRITE_SCOPES = ['read write', 'write'];

    // false = only list + get (no create)
    var RUN_CREATE = true;

    // Optional: specific asset id to GET. Blank = first asset from the list.
    var GET_ASSET_ID = '';

    // ==========================================
    // HARDCODED ASSET
    // ==========================================
    var HARDCODED_ASSET = {
        asset: {
            name: 'Dhruv Test',
            asset_type_id: '01M66KSY9W5XGPN4BJVST123JK',   // Bot
            organization_id: 33916744664596,               // same org as "Sample 1"
            status_id: '01KKM6AZDZMGVVH3DRAVD3AANN',       // same status as "Sample 1"
            manufacturer: 'Mytra',
            model: 'Gen3',
            serial_number: '12345'
            // external_id: 'NS-12345',
            // notes: '',
            // custom_field_values: {
            //     tool_name: '',
            //     asset_tag___barcode_id: '',
            //     deployment_status: '',
            //     kit___toolbag: ''
            // },
            // user_id: 0,
            // location_id: '',
            // asset_tag: '',
            // manufacturer: '',
            // model: '',
            // purchase_date: 'YYYY-MM-DD',
            // purchase_cost: 0,
            // vendor: '',
            // warranty_expiration: 'YYYY-MM-DD'
        }
    };

    function parse(body) {
        try {
            return JSON.parse(body);
        } catch (e) {
            return { raw: body };
        }
    }

    function logData(title, value) {
        var str = JSON.stringify(value, null, 2) || 'null';
        var size = 3500;
        var total = Math.ceil(str.length / size) || 1;

        for (var i = 0; i < total; i++) {
            log.audit(
                title + ' PART ' + (i + 1) + '/' + total,
                str.substring(i * size, (i + 1) * size)
            );
        }
    }

    function getToken(scope) {

        var res = https.post({
            url: BASE_URL + '/oauth/tokens',
            headers: {
                'Content-Type': 'application/json',
                Accept: 'application/json'
            },
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
                scope: scope,
                code: res.code,
                error: data.error,
                description: data.error_description
            });
            return null;
        }

        log.audit('OAUTH SUCCESS', {
            requestedScope: scope,
            grantedScope: data.scope
        });

        return data.access_token;
    }

    function getAPI(token, endpoint) {

        var res = https.get({
            url: BASE_URL + endpoint,
            headers: {
                Authorization: 'Bearer ' + token,
                Accept: 'application/json'
            }
        });

        var data = parse(res.body);

        log.audit('API RESULT', {
            endpoint: endpoint,
            httpCode: res.code
        });

        if (Number(res.code) !== 200) {
            logData('API ERROR', {
                endpoint: endpoint,
                code: res.code,
                response: data
            });
        }

        return {
            code: Number(res.code),
            data: data
        };
    }

    function postAPI(token, endpoint, payload) {

        var res = https.post({
            url: BASE_URL + endpoint,
            headers: {
                Authorization: 'Bearer ' + token,
                Accept: 'application/json',
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload)
        });

        var data = parse(res.body);
        var code = Number(res.code);

        log.audit('API POST RESULT', {
            endpoint: endpoint,
            httpCode: code
        });

        if (code < 200 || code >= 300) {
            logData('API POST ERROR', {
                endpoint: endpoint,
                code: code,
                payload: payload,
                response: data
            });
        }

        return {
            code: code,
            data: data
        };
    }

    // ==========================================
    // FIRST ASSET STATUS (status_id is required)
    // GET /api/v2/it_asset_management/statuses
    // ==========================================
    function getFirstStatusId(token) {

        var result = getAPI(token, '/api/v2/it_asset_management/statuses');

        if (result.code !== 200) return null;

        var statuses = result.data.statuses || [];
        logData('ASSET STATUSES', statuses);

        return statuses.length ? statuses[0].id : null;
    }

    // ==========================================
    // LIST ASSETS
    // GET /api/v2/it_asset_management/assets
    // ==========================================
    function listAssets(token) {

        var result = getAPI(token, '/api/v2/it_asset_management/assets?page[size]=10');

        if (result.code !== 200) return [];

        var assets = result.data.assets || [];

        log.audit('LIST ASSETS', {
            countThisPage: assets.length,
            hasMore: result.data.meta ? result.data.meta.has_more : null
        });

        for (var i = 0; i < assets.length; i++) {
            logData('ASSET ' + (i + 1), assets[i]);
        }

        return assets;
    }

    // ==========================================
    // GET ONE ASSET
    // GET /api/v2/it_asset_management/assets/{asset_id}
    // ==========================================
    function getAsset(token, assetId) {

        if (!assetId) {
            log.audit('GET ASSET SKIPPED', 'No asset id');
            return null;
        }

        var result = getAPI(token,
            '/api/v2/it_asset_management/assets/' + encodeURIComponent(assetId));

        if (result.code === 200) {
            logData('GET ASSET ' + assetId, result.data.asset);
            return result.data.asset;
        }

        return null;
    }

    // ==========================================
    // GET ASSET TYPE (the Bot type from the customer)
    // GET /api/v2/it_asset_management/asset_types/{id}
    // ==========================================
    function getAssetType(token, typeId) {

        var result = getAPI(token,
            '/api/v2/it_asset_management/asset_types/' + encodeURIComponent(typeId));

        if (result.code === 200) {
            logData('GET ASSET TYPE ' + typeId, result.data);
        }
    }

    // ==========================================
    // CREATE HARDCODED ASSET
    // POST /api/v2/it_asset_management/assets
    // ==========================================
    function createHardcodedAsset(token) {

        var payload = JSON.parse(JSON.stringify(HARDCODED_ASSET));

        if (!payload.asset.status_id) {
            var statusId = getFirstStatusId(token);
            if (statusId) payload.asset.status_id = statusId;
        }

        logData('CREATE ASSET PAYLOAD', payload);

        var typeId = encodeURIComponent(payload.asset.asset_type_id);

        // Tried in order; stops at the first 2xx so only one asset is created
        var endpoints = [
            '/api/v2/it_asset_management/' + typeId + '/assets',  // asset-type path
            '/api/v2/it_asset_management/assets'                              // documented path
        ];

        for (var i = 0; i < endpoints.length; i++) {

            var result = postAPI(token, endpoints[i], payload);

            if (result.code >= 200 && result.code < 300) {
                log.audit('ASSET CREATED VIA', endpoints[i]);
                logData('ASSET CREATED', result.data);
                return result.data.asset;
            }

            log.audit('CREATE FAILED ON ENDPOINT', {
                endpoint: endpoints[i],
                httpCode: result.code
            });
        }

        return null;
    }

    function getInputData() {
        return [{ id: 1 }];
    }

    function map(context) {

        try {

            log.audit('ZENDESK STARTED', BASE_URL);

            // ---------- READ: list + get ----------
            var readToken = null;
            for (var r = 0; r < READ_SCOPES.length && !readToken; r++) {
                readToken = getToken(READ_SCOPES[r]);
            }

            if (readToken) {
                var assets = listAssets(readToken);
                getAsset(readToken, GET_ASSET_ID || (assets[0] && assets[0].id));
                getAssetType(readToken, HARDCODED_ASSET.asset.asset_type_id);
                getFirstStatusId(readToken);
            } else {
                log.error('READ SKIPPED', 'No read scope allowed on the OAuth client');
            }

            if (!RUN_CREATE) {
                log.audit('ZENDESK FINISHED', 'Read-only run (RUN_CREATE = false)');
                return;
            }

            // ---------- WRITE: create ----------
            var token = null;
            for (var i = 0; i < WRITE_SCOPES.length && !token; i++) {
                token = getToken(WRITE_SCOPES[i]);
            }

            if (!token) {
                log.error('CREATE ASSET SKIPPED',
                    'OAuth client ' + CLIENT_ID + ' does not allow write scope. ' +
                    'Add Read + Write in Admin Center > Apps and integrations > APIs > OAuth clients.');
                return;
            }

            var created = createHardcodedAsset(token);

            log.audit('ZENDESK FINISHED', {
                assetCreated: !!created,
                zendeskAssetId: created ? created.id : null
            });

        } catch (e) {
            log.error('ZENDESK ERROR', {
                name: e.name,
                message: e.message,
                stack: e.stack
            });
            throw e;
        }
    }

    function summarize(summary) {

        if (summary.inputSummary.error) {
            log.error('INPUT ERROR', summary.inputSummary.error);
        }

        summary.mapSummary.errors.iterator().each(
            function(key, error) {
                log.error('MAP ERROR ' + key, error);
                return true;
            }
        );

        log.audit('SUMMARY', {
            usage: summary.usage,
            yields: summary.yields,
            seconds: summary.seconds
        });
    }

    return {
        getInputData: getInputData,
        map: map,
        summarize: summarize
    };
});