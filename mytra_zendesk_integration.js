/**
 * @NApiVersion 2.1
 * @NScriptType MapReduceScript
 */
define(['N/https', 'N/log'], function(https, log) {

    // =============================================
    // CONFIGURATION
    // =============================================
    var BASE_URL = 'https://mytra.zendesk.com';
    var CLIENT_ID = 'netsuite_fsm_integration';
    var CLIENT_SECRET = '4f1beaf8b4a16f576d75f7bc4d8e77d63ac1d07a23d6f4293036c4fe62ef5779';

    var CREATE_ENABLED = false;

    var ASSET_TYPE_ID = '01M66KSY9W5XGPN4BJVST123JK';
    var ORGANIZATION_ID = 55112815315988;

    var ASSET = {
        name: 'MYT-00067-00 P1 BOT ASM MYT-00067-00-00004',
        external_id: '224',
        serial_number: 'MYT-00067-00-00004',
        model: 'MYT-00067-00 P1 BOT ASM',
        warranty_expiration: '2028-04-01',
        notes: 'NetSuite Asset ID: 224. ' +
               'Status: On Lease. ' +
               'Lease Start: 2026-10-01. ' +
               'Lease End: 2027-05-31.'
    };

    // =============================================
    // LOG JSON IN PARTS
    // =============================================
    function logData(title, data) {

        var value = JSON.stringify(data, null, 2) || 'null';
        var size = 3500;
        var total = Math.ceil(value.length / size);

        for (var i = 0; i < total; i++) {
            log.audit(
                title + ' PART ' + (i + 1) + '/' + total,
                value.substring(i * size, (i + 1) * size)
            );
        }
    }

    // =============================================
    // OAUTH TOKEN
    // =============================================
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

        var data = {};

        try {
            data = JSON.parse(res.body);
        } catch (e) {
            data = {raw: res.body};
        }

        if (Number(res.code) !== 200 ||
            !data.access_token) {

            log.error('OAUTH FAILED', {
                requestedScope: scope,
                httpCode: res.code,
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

    // =============================================
    // GENERIC GET
    // =============================================
    function getAPI(token, endpoint) {

        var url = endpoint.indexOf('https://') === 0
            ? endpoint
            : BASE_URL + endpoint;

        if (url.indexOf(
            BASE_URL + '/api/v2/it_asset_management/'
        ) !== 0) {
            throw Error('Unexpected Zendesk URL');
        }

        var res = https.get({
            url: url,
            headers: {
                Authorization: 'Bearer ' + token,
                Accept: 'application/json'
            }
        });

        var data = {};

        try {
            data = JSON.parse(res.body);
        } catch (e) {
            data = {raw: res.body};
        }

        log.audit('API GET RESULT', {
            endpoint: endpoint,
            httpCode: res.code
        });

        if (Number(res.code) !== 200) {
            logData('API GET ERROR', {
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

    // =============================================
    // GET EXISTING ASSETS
    // =============================================
    function getAssets(token) {

        var next =
            '/api/v2/it_asset_management/assets' +
            '?page[size]=100';

        var count = 0;
        var pages = 0;
        var found = false;

        while (next && pages < 100) {

            pages++;

            var result = getAPI(token, next);

            if (result.code !== 200) {
                return {success: false};
            }

            if (!Array.isArray(result.data.assets)) {
                log.error('INVALID ASSET RESPONSE',
                    result.data);
                return {success: false};
            }

            var rows = result.data.assets;

            for (var i = 0; i < rows.length; i++) {

                count++;

                var asset = rows[i];

                logData(
                    'EXISTING ASSET ' + count,
                    asset
                );

                if (
                    String(asset.external_id || '') ===
                        ASSET.external_id ||
                    asset.serial_number ===
                        ASSET.serial_number
                ) {
                    found = true;

                    log.audit('MATCHING ASSET FOUND', {
                        zendeskAssetId: asset.id,
                        externalId: asset.external_id,
                        name: asset.name,
                        serial: asset.serial_number
                    });
                }
            }

            log.audit('ASSET PAGE', {
                page: pages,
                records: rows.length,
                total: count
            });

            var meta = result.data.meta || {};
            var links = result.data.links || {};

            if (meta.has_more) {

                if (links.next) {
                    next = links.next;
                } else if (meta.after_cursor) {
                    next =
                        '/api/v2/it_asset_management/assets' +
                        '?page[size]=100&page[after]=' +
                        encodeURIComponent(
                            meta.after_cursor
                        );
                } else {
                    log.error('PAGINATION ERROR',
                        'Missing asset next cursor');
                    return {success: false};
                }

            } else {
                next = null;
            }
        }

        if (next) {
            log.error('ASSET LIST INCOMPLETE',
                'Pagination limit reached');

            return {success: false};
        }

        log.audit('ALL ASSETS RETRIEVED', {
            total: count,
            pages: pages,
            matchingAssetExists: found
        });

        return {
            success: true,
            count: count,
            exists: found
        };
    }

    // =============================================
    // GET ASSET TYPES
    // =============================================
    function getAssetTypes(token) {

        var result = getAPI(
            token,
            '/api/v2/it_asset_management/asset_types'
        );

        if (result.code !== 200) return false;

        var rows = result.data.asset_types || [];
        var found = false;

        for (var i = 0; i < rows.length; i++) {

            logData('ASSET TYPE ' + (i + 1), rows[i]);

            if (String(rows[i].id) === ASSET_TYPE_ID) {
                found = true;
            }
        }

        log.audit('BOT ASSET TYPE CHECK', {
            assetTypeId: ASSET_TYPE_ID,
            found: found
        });

        return found;
    }

    // =============================================
    // GET ASSET FIELDS
    // =============================================
    function getAssetFields(token) {

        var result = getAPI(
            token,
            '/api/v2/it_asset_management/asset_types/' +
            ASSET_TYPE_ID + '/fields'
        );

        if (result.code !== 200) return false;

        logData('BOT ASSET FIELD DEFINITIONS',
            result.data);

        return true;
    }

    // =============================================
    // GET ASSET STATUSES
    // =============================================
    function getStatuses(token) {

        var result = getAPI(
            token,
            '/api/v2/it_asset_management/statuses'
        );

        if (result.code !== 200) return null;

        var rows = result.data.statuses || [];
        var selected = null;

        for (var i = 0; i < rows.length; i++) {

            logData(
                'ASSET STATUS ' + (i + 1),
                rows[i]
            );

            if (
                String(rows[i].name || '')
                    .toLowerCase() === 'on lease'
            ) {
                selected = rows[i];
            }
        }

        // Do not silently substitute an unrelated status.
        if (!selected) {
            log.error('ON LEASE STATUS NOT FOUND',
                'Review available statuses and choose the correct mapping');

            return null;
        }

        log.audit('SELECTED ASSET STATUS', {
            id: selected.id,
            name: selected.name
        });

        return selected.id;
    }

    // =============================================
    // CREATE ASSET
    // =============================================
    function createAsset(token, statusId) {

        var payload = {
            asset: {
                name: ASSET.name,
                asset_type_id: ASSET_TYPE_ID,
                status_id: statusId,
                organization_id: ORGANIZATION_ID,
                external_id: ASSET.external_id,
                serial_number: ASSET.serial_number,
                model: ASSET.model,
                warranty_expiration:
                    ASSET.warranty_expiration,
                notes: ASSET.notes
            }
        };

        logData('ASSET CREATE PAYLOAD', payload);

        var res = https.post({
            url: BASE_URL +
                '/api/v2/it_asset_management/assets',
            headers: {
                Authorization: 'Bearer ' + token,
                'Content-Type': 'application/json',
                Accept: 'application/json'
            },
            body: JSON.stringify(payload)
        });

        var result = {};

        try {
            result = JSON.parse(res.body);
        } catch (e) {
            result = {raw: res.body};
        }

        logData('ASSET CREATE RESPONSE', {
            code: res.code,
            data: result
        });

        if (Number(res.code) === 201 &&
            result.asset && result.asset.id) {

            log.audit('ZENDESK ASSET CREATED', {
                zendeskAssetId: result.asset.id,
                netsuiteAssetId: ASSET.external_id,
                organizationId: ORGANIZATION_ID,
                name: result.asset.name
            });

        } else {

            log.error('ASSET CREATION FAILED', {
                code: res.code,
                response: result
            });
        }
    }

    // =============================================
    // MAP REDUCE
    // =============================================
    function getInputData() {
        return [{id: 224}];
    }

    function map(context) {

        try {

            log.audit('ASSET TEST STARTED', {
                createEnabled: CREATE_ENABLED,
                assetId: ASSET.external_id,
                organizationId: ORGANIZATION_ID,
                assetTypeId: ASSET_TYPE_ID
            });

            var readToken = getToken('read');

            if (!readToken) {

                log.error('ASSET TEST BLOCKED', {
                    reason: 'OAuth read scope unavailable',
                    nextStep:
                        'Authorize read scope on Zendesk OAuth client',
                    assetCreationAttempted: false
                });

                return;
            }

            var existing = getAssets(readToken);

            if (!existing.success) {
                log.error('TEST STOPPED',
                    'Could not retrieve all existing assets');
                return;
            }

            var typeFound = getAssetTypes(readToken);
            var fieldsFound = getAssetFields(readToken);
            var statusId = getStatuses(readToken);

            log.audit('ASSET DIAGNOSTIC SUMMARY', {
                existingAssets: existing.count,
                matchingAssetExists: existing.exists,
                botAssetTypeFound: typeFound,
                botFieldsRetrieved: fieldsFound,
                statusId: statusId,
                createEnabled: CREATE_ENABLED
            });

            if (!CREATE_ENABLED) {

                log.audit('READ ONLY TEST COMPLETED',
                    'No Zendesk records changed');

                return;
            }

            if (existing.exists) {

                log.audit('ASSET CREATION SKIPPED',
                    'Matching external ID or serial already exists');

                return;
            }

            if (!typeFound || !fieldsFound || !statusId) {

                log.error('ASSET CREATION SKIPPED',
                    'Required configuration missing');

                return;
            }

            var writeToken = getToken('write');

            if (!writeToken) {

                log.error('CREATE BLOCKED',
                    'Zendesk write scope not granted');

                return;
            }

            createAsset(writeToken, statusId);

        } catch (e) {

            log.error('ASSET TEST ERROR', {
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

        log.audit('ASSET TEST FINISHED', {
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
