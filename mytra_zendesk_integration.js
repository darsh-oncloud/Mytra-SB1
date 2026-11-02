
/**
 * @NApiVersion 2.1
 * @NScriptType MapReduceScript
 */
define(['N/https', 'N/log'], function(https, log) {

    var BASE_URL = 'https://mytra.zendesk.com';
    var CLIENT_ID = 'netsuite_fsm_integration';
    var CLIENT_SECRET = 'PASTE_ROTATED_SECRET_HERE';

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

    // ==========================================
    // ALL ZENDESK CUSTOM OBJECT DEFINITIONS
    // ==========================================
    function getCustomObjects(token) {

        var result = getAPI(
            token,
            '/api/v2/custom_objects'
        );

        if (result.code !== 200) return;

        var objects = result.data.custom_objects || [];

        log.audit('TOTAL CUSTOM OBJECT TYPES', {
            count: objects.length
        });

        for (var i = 0; i < objects.length; i++) {

            var obj = objects[i];

            logData('CUSTOM OBJECT ' + (i + 1), obj);

            var key = encodeURIComponent(obj.key);

            var fields = getAPI(
                token,
                '/api/v2/custom_objects/' + key + '/fields'
            );

            if (fields.code === 200) {
                logData('CUSTOM OBJECT FIELDS - ' + obj.key,
                    fields.data);
            }

            var count = getAPI(
                token,
                '/api/v2/custom_objects/' +
                key + '/records/count'
            );

            if (count.code === 200) {
                logData('CUSTOM OBJECT RECORD COUNT - ' +
                    obj.key, count.data);
            }
        }

        var limits = getAPI(
            token,
            '/api/v2/custom_objects/limits/object_limit'
        );

        if (limits.code === 200) {
            logData('CUSTOM OBJECT ACCOUNT LIMITS',
                limits.data);
        }
    }

    // ==========================================
    // NATIVE ZENDESK ASSET TYPES
    // ==========================================
    function getNativeAssetTypes(token) {

        var result = getAPI(
            token,
            '/api/v2/it_asset_management/asset_types'
        );

        if (result.code !== 200) return;

        var types = result.data.asset_types || [];

        log.audit('TOTAL NATIVE ASSET TYPES', {
            count: types.length
        });

        for (var i = 0; i < types.length; i++) {
            logData('NATIVE ASSET TYPE ' + (i + 1),
                types[i]);
        }
    }

    function getInputData() {
        return [{ id: 1 }];
    }

    function map(context) {

        try {

            log.audit('ZENDESK FULL DISCOVERY STARTED',
                BASE_URL);

            // Confirmed working in your latest logs.
            var token = getToken('custom_objects:read');

            if (token) {
                getCustomObjects(token);

                // This API may require different scopes.
                getNativeAssetTypes(token);
            }

            log.audit('ZENDESK FULL DISCOVERY FINISHED',
                'No records created or modified');

        } catch (e) {
            log.error('DISCOVERY ERROR', {
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

        log.audit('DISCOVERY SUMMARY', {
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
