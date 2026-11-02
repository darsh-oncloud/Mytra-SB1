/**
 * @NApiVersion 2.1
 * @NScriptType MapReduceScript
 */
define(['N/https', 'N/log'], function(https, log) {

    var BASE_URL = 'https://mytra.zendesk.com';
    var CLIENT_ID = 'netsuite_fsm_integration';
    var CLIENT_SECRET = '4f1beaf8b4a16f576d75f7bc4d8e77d63ac1d07a23d6f4293036c4fe62ef5779';

    var KNOWN_OBJECT_KEY = 'ezo_cmms_assets';

    // ================================================
    // PARSE RESPONSE
    // ================================================
    function parseJSON(body) {
        try {
            return JSON.parse(body);
        } catch (e) {
            return { raw: body };
        }
    }

    // ================================================
    // GET ZENDESK TOKEN
    // ================================================
    function getToken(scope) {

        var response = https.post({
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

        var data = parseJSON(response.body);

        if (Number(response.code) !== 200 ||
            !data.access_token) {

            log.error('OAUTH FAILED', {
                scope: scope,
                httpCode: response.code,
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

    // ================================================
    // GENERIC GET REQUEST
    // ================================================
    function getAPI(token, endpoint) {

        var response = https.get({
            url: BASE_URL + endpoint,
            headers: {
                Authorization: 'Bearer ' + token,
                Accept: 'application/json'
            }
        });

        var data = parseJSON(response.body);

        log.audit('API REQUEST', {
            endpoint: endpoint,
            httpCode: response.code
        });

        if (Number(response.code) !== 200) {

            log.error('API ERROR', {
                endpoint: endpoint,
                httpCode: response.code,
                response: data
            });
        }

        return {
            code: Number(response.code),
            data: data
        };
    }

    // ================================================
    // COUNT RECORDS FOR EACH CUSTOM OBJECT
    // ================================================
    function getRecordCount(token, objectKey) {

        var endpoint =
            '/api/v2/custom_objects/' +
            encodeURIComponent(objectKey) +
            '/records/count';

        var result = getAPI(token, endpoint);

        if (result.code !== 200) {
            return null;
        }

        var countData = result.data.count;

        // Zendesk may return count metadata
        // inside an object.
        var count = countData;

        if (countData && typeof countData === 'object') {
            count = countData.value;
        }

        return count === undefined ? null : count;
    }

    // ================================================
    // LIST ALL CUSTOM OBJECT DEFINITIONS
    // ================================================
    function listCustomObjects(token) {

        var result = getAPI(
            token,
            '/api/v2/custom_objects'
        );

        if (result.code !== 200) {
            return false;
        }

        var objects = result.data.custom_objects || [];

        if (!Array.isArray(objects)) {
            log.error('INVALID RESPONSE', result.data);
            return false;
        }

        log.audit('TOTAL CUSTOM OBJECTS', {
            total: objects.length
        });

        var knownFound = false;

        for (var i = 0; i < objects.length; i++) {

            var obj = objects[i];

            var objectKey = obj.key;

            var recordCount =
                getRecordCount(token, objectKey);

            log.audit(
                'CUSTOM OBJECT ' + (i + 1) +
                ' - ' + obj.title,
                {
                    key: obj.key,
                    title: obj.title,
                    titlePlural: obj.title_pluralized,
                    description: obj.description,
                    objectId: obj.id || '',
                    url: obj.url,
                    createdAt: obj.created_at,
                    updatedAt: obj.updated_at,
                    existingRecordCount: recordCount
                }
            );

            if (obj.key === KNOWN_OBJECT_KEY) {

                knownFound = true;

                log.audit('KNOWN ASSET OBJECT FOUND', {
                    key: obj.key,
                    title: obj.title,
                    recordCount: recordCount
                });
            }
        }

        log.audit('CUSTOM OBJECT DISCOVERY COMPLETED', {
            totalObjects: objects.length,
            knownObjectKey: KNOWN_OBJECT_KEY,
            knownObjectFound: knownFound
        });

        return true;
    }

    // ================================================
    // INPUT
    // ================================================
    function getInputData() {
        return [{ id: 1 }];
    }

    // ================================================
    // MAP
    // ================================================
    function map(context) {

        try {

            log.audit('ZENDESK CUSTOM OBJECT TEST STARTED',
                BASE_URL);

            // Try the specific read scope first.
            var token = getToken('custom_objects:read');

            if (token) {

                var success = listCustomObjects(token);

                if (success) {
                    return;
                }
            }

            // Earlier logs showed this scope was granted.
            // Test whether it also permits GET access.
            log.audit('RETRY WITH WRITE TOKEN',
                'Testing existing OAuth permissions');

            token = getToken('custom_objects:write');

            if (!token) {
                log.error('TEST STOPPED',
                    'No usable OAuth token');
                return;
            }

            var result = listCustomObjects(token);

            if (!result) {

                log.error('CUSTOM OBJECT ACCESS BLOCKED', {
                    reason:
                        'OAuth token does not have required read permissions',
                    requiredScope: 'custom_objects:read'
                });
            }

        } catch (e) {

            log.error('SCRIPT ERROR', {
                name: e.name,
                message: e.message,
                stack: e.stack
            });

            throw e;
        }
    }

    // ================================================
    // SUMMARY
    // ================================================
    function summarize(summary) {

        if (summary.inputSummary.error) {
            log.error(
                'INPUT ERROR',
                summary.inputSummary.error
            );
        }

        summary.mapSummary.errors.iterator().each(
            function(key, error) {

                log.error('MAP ERROR ' + key, error);
                return true;
            }
        );

        log.audit('CUSTOM OBJECT TEST FINISHED', {
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
