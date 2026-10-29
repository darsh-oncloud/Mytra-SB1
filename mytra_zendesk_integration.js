/**
 * @NApiVersion 2.1
 * @NScriptType MapReduceScript
 */
define(['N/https', 'N/log'], function(https, log) {

    var BASE_URL = 'https://mytra.zendesk.com';
    var CLIENT_ID = 'netsuite_fsm_integration';
    var CLIENT_SECRET = '4f1beaf8b4a16f576d75f7bc4d8e77d63ac1d07a23d6f4293036c4fe62ef5779';

    // Assumed Zendesk Asset custom-object key
    var ASSET_OBJECT_KEY = 'asset';

    function getToken() {

        var response = https.post({
            url: BASE_URL + '/oauth/tokens',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            },
            body: JSON.stringify({
                grant_type: 'client_credentials',
                client_id: CLIENT_ID,
                client_secret: CLIENT_SECRET,
                scope: 'custom_objects:write'
            })
        });

        if (Number(response.code) !== 200) {
            log.error('OAUTH FAILED', {
                code: response.code,
                body: response.body
            });
            return null;
        }

        var data = JSON.parse(response.body);

        log.audit('OAUTH SUCCESS', {
            grantedScope: data.scope
        });

        return data.access_token;
    }

    function getInputData() {
        return [{id: 224}];
    }

    function map(context) {

        try {

            var token = getToken();
            if (!token) return;

            var payload = {
                custom_object_record: {
                    name: 'MYT-00067-00 P1 BOT ASM MYT-00067-00-00004',
                    external_id: '224'
                }
            };

            var endpoint = BASE_URL +
                '/api/v2/custom_objects/' +
                encodeURIComponent(ASSET_OBJECT_KEY) +
                '/records';

            log.audit('ASSET CREATE PAYLOAD', payload);

            var response = https.post({
                url: endpoint,
                headers: {
                    Authorization: 'Bearer ' + token,
                    'Content-Type': 'application/json',
                    Accept: 'application/json'
                },
                body: JSON.stringify(payload)
            });

            var result;

            try {
                result = JSON.parse(response.body);
            } catch (e) {
                result = {raw: response.body};
            }

            log.audit('ASSET API RESPONSE', {
                httpCode: response.code,
                result: result
            });

            if (Number(response.code) === 201) {

                log.audit('ZENDESK ASSET CREATED', {
                    zendeskAssetId:
                        result.custom_object_record.id,
                    netsuiteAssetId: 224,
                    assetName:
                        result.custom_object_record.name
                });

            } else {

                log.error('ASSET CREATION FAILED', {
                    httpCode: response.code,
                    response: result
                });
            }

        } catch (e) {

            log.error('ASSET SCRIPT ERROR', {
                name: e.name,
                message: e.message,
                stack: e.stack
            });
        }
    }

    function summarize(summary) {

        summary.mapSummary.errors.iterator().each(
            function(key, error) {
                log.error('MAP ERROR ' + key, error);
                return true;
            }
        );

        log.audit('ASSET TEST FINISHED', {
            usage: summary.usage,
            yields: summary.yields
        });
    }

    return {
        getInputData: getInputData,
        map: map,
        summarize: summarize
    };
});
