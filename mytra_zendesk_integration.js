/**
 * @NApiVersion 2.1
 * @NScriptType MapReduceScript
 */
define(['N/https', 'N/log'], function(https, log) {

    var BASE_URL = 'https://mytra.zendesk.com';
    var CLIENT_ID = 'netsuite_fsm_integration';
    var CLIENT_SECRET = '4f1beaf8b4a16f576d75f7bc4d8e77d63ac1d07a23d6f4293036c4fe62ef5779';

    // Hardcoded NetSuite Customer
    var CUSTOMER = {
        name: 'Baxter Healthcare Corporation',
        external_id: 'CUST-100001',
        street: 'ONE BAXTER PKWY',
        city: 'DEERFIELD',
        state: 'IL',
        zip: '60015'
    };

    // Hardcoded NetSuite Field Service Asset
    var ASSET = {
        name: 'MYT-00067-00 P1 BOT ASM MYT-00067-00-00004',
        external_id: '224',
        serial: 'MYT-00067-00-00004',
        item: 'MYT-00067-00 P1 BOT ASM',
        status: 'On Lease',
        lease_start: '2026-10-01',
        lease_end: '2027-05-31',
        under_warranty: true,
        warranty_start: '2026-10-01',
        warranty_end: '2028-04-01'
    };

    // =================================================
    // OAUTH TOKEN
    // =================================================
    function getToken(scope) {

        var res = https.post({
            url: BASE_URL + '/oauth/tokens',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            },
            body: JSON.stringify({
                grant_type: 'client_credentials',
                client_id: CLIENT_ID,
                client_secret: CLIENT_SECRET,
                scope: scope
            })
        });

        if (Number(res.code) !== 200) {
            log.error('OAUTH FAILED', {
                scope: scope,
                code: res.code,
                body: res.body
            });
            return null;
        }

        var data = JSON.parse(res.body);

        log.audit('OAUTH SUCCESS', {
            requestedScope: scope,
            grantedScope: data.scope || ''
        });

        return data.access_token;
    }

    // =================================================
    // GENERIC API
    // =================================================
    function api(token, method, endpoint, payload) {

        var options = {
            url: BASE_URL + endpoint,
            headers: {
                Authorization: 'Bearer ' + token,
                'Content-Type': 'application/json',
                Accept: 'application/json'
            }
        };

        if (payload) {
            options.body = JSON.stringify(payload);
            log.audit('REQUEST PAYLOAD - ' + endpoint,
                options.body);
        }

        var res = method === 'POST'
            ? https.post(options)
            : https.get(options);

        var body;

        try {
            body = JSON.parse(res.body);
        } catch (e) {
            body = {raw: res.body};
        }

        log.audit('API RESPONSE - ' + endpoint, {
            code: res.code,
            data: body
        });

        return {
            code: Number(res.code),
            data: body
        };
    }

    // =================================================
    // CREATE OR UPDATE ORGANIZATION
    // =================================================
    function createOrganization(token) {

        var payload = {
            organization: {
                name: CUSTOMER.name,
                external_id: CUSTOMER.external_id,
                organization_fields: {
                    street_address: CUSTOMER.street,
                    city: CUSTOMER.city,
                    state: CUSTOMER.state,
                    zip_code: CUSTOMER.zip
                }
            }
        };

        var result = api(
            token,
            'POST',
            '/api/v2/organizations/create_or_update.json',
            payload
        );

        if (result.code !== 200 && result.code !== 201) {
            log.error('ORGANIZATION CREATE FAILED', result);
            return null;
        }

        var org = result.data.organization;

        log.audit('ORGANIZATION SUCCESS', {
            zendeskId: org.id,
            name: org.name,
            externalId: org.external_id
        });

        return org;
    }

    // =================================================
    // DISCOVER EXISTING ASSET OBJECT
    // =================================================
    function findAssetObject(token) {

        var result = api(
            token,
            'GET',
            '/api/v2/custom_objects'
        );

        if (result.code !== 200) {
            log.error('ASSET OBJECT LOOKUP FAILED',
                'Unable to read custom object definitions');
            return null;
        }

        var objects = result.data.custom_objects || [];

        for (var i = 0; i < objects.length; i++) {

            var obj = objects[i];

            var name = (
                (obj.key || '') + ' ' +
                (obj.title || '') + ' ' +
                (obj.title_pluralized || '')
            ).toLowerCase();

            if (name.indexOf('asset') !== -1) {

                log.audit('ASSET OBJECT FOUND', obj);
                return obj.key;
            }
        }

        log.error('ASSET OBJECT NOT FOUND',
            'No existing custom object named Asset');

        return null;
    }

    // =================================================
    // CREATE ASSET
    // =================================================
    function createAsset(token, objectKey, organization) {

        // Minimal test payload because the actual Asset
        // custom field keys are not yet confirmed.
        var payload = {
            custom_object_record: {
                name: ASSET.name,
                external_id: ASSET.external_id
            }
        };

        log.audit('NETSUITE ASSET SOURCE DATA', {
            asset: ASSET,
            organizationName: organization.name,
            organizationZendeskId: organization.id
        });

        var endpoint = '/api/v2/custom_objects/' +
            encodeURIComponent(objectKey) + '/records';

        // Check existing Asset by NetSuite internal ID
        var lookup = api(
            token,
            'GET',
            endpoint +
            '/show_by_unique_identifier?external_id=' +
            encodeURIComponent(ASSET.external_id)
        );

        if (lookup.code === 200) {

            log.audit('ASSET ALREADY EXISTS', {
                zendeskAsset: lookup.data.custom_object_record
            });

            return;
        }

        if (lookup.code !== 404) {
            log.error('ASSET LOOKUP FAILED',
                'Creation skipped because lookup was unsuccessful');
            return;
        }

        var result = api(
            token,
            'POST',
            endpoint,
            payload
        );

        if (result.code !== 201) {

            log.error('ASSET CREATE FAILED', {
                code: result.code,
                response: result.data,
                asset: ASSET
            });

            return;
        }

        log.audit('ASSET CREATED SUCCESSFULLY', {
            zendeskAsset: result.data.custom_object_record,
            netsuiteAssetId: ASSET.external_id,
            organizationId: organization.id
        });
    }

    // =================================================
    // MAP REDUCE
    // =================================================
    function getInputData() {
        return [{id: 1}];
    }

    function map(context) {

        try {

            log.audit('ZENDESK TEST STARTED',
                'Organization and Asset creation');

            // Organization token
            var orgToken = getToken(
                'organizations:write'
            );

            if (!orgToken) return;

            var organization = createOrganization(orgToken);

            if (!organization) return;

            // Custom Object token
            var assetToken = getToken(
                'custom_objects:write'
            );

            if (!assetToken) return;

            // Discover Asset object
            var objectKey = findAssetObject(assetToken);

            // Try read scope if write token cannot
            // access object definitions.
            if (!objectKey) {

                var readToken = getToken(
                    'custom_objects:read'
                );

                if (readToken) {
                    objectKey = findAssetObject(readToken);
                }
            }

            if (!objectKey) {
                log.error('ASSET CREATION SKIPPED',
                    'Asset custom object key not available');
                return;
            }

            createAsset(assetToken, objectKey, organization);

            log.audit('ZENDESK TEST COMPLETED',
                'Check organization and asset logs');

        } catch (e) {

            log.error('TEST ERROR', {
                name: e.name,
                message: e.message,
                stack: e.stack
            });

            throw e;
        }
    }

    function summarize(summary) {

        if (summary.inputSummary.error) {
            log.error('INPUT ERROR',
                summary.inputSummary.error);
        }

        summary.mapSummary.errors.iterator().each(
            function(key, error) {
                log.error('MAP ERROR ' + key, error);
                return true;
            }
        );

        log.audit('TEST SUMMARY', {
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
