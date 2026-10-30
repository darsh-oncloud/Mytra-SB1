/**
 * @NApiVersion 2.1
 * @NScriptType MapReduceScript
 */
define(['N/https', 'N/log'], function(https, log) {

    // ================================================
    // ZENDESK CONFIGURATION
    // ================================================
    var BASE_URL = 'https://mytra.zendesk.com';
    var CLIENT_ID = 'netsuite_fsm_integration';
    var CLIENT_SECRET = '4f1beaf8b4a16f576d75f7bc4d8e77d63ac1d07a23d6f4293036c4fe62ef5779';

    // First test false, then change to true.
    var CREATE_ENABLED = false;

    var ASSET_TYPE_ID = '01M66KSY9W5XGPN4BJVST123JK';
    var ORGANIZATION_ID = 55112815315988;

    var ASSET = {
        name: 'MYT-00067-00 P1 BOT ASM MYT-00067-00-00004',
        external_id: '224',
        serial_number: 'MYT-00067-00-00004',
        model: 'MYT-00067-00 P1 BOT ASM',
        warranty_expiration: '2028-04-01',
        notes: 'NetSuite Field Service Asset ID: 224. ' +
               'NetSuite Status: On Lease. ' +
               'Lease Start: 2026-10-01. ' +
               'Lease End: 2027-05-31.'
    };

    // ================================================
    // LOG COMPLETE JSON IN PARTS
    // ================================================
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

    // ================================================
    // OAUTH TOKEN
    // ================================================
    function getToken(scope) {

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
                scope: scope
            })
        });

        if (Number(response.code) !== 200) {

            log.error('OAUTH FAILED', {
                scope: scope,
                code: response.code,
                body: response.body
            });

            return null;
        }

        var data = JSON.parse(response.body);

        log.audit('OAUTH SUCCESS', {
            requestedScope: scope,
            grantedScope: data.scope,
            hasToken: !!data.access_token
        });

        return data.access_token || null;
    }

    // ================================================
    // GENERIC GET API
    // ================================================
    function getAPI(token, endpoint) {

        var url = endpoint.indexOf('https://') === 0
            ? endpoint
            : BASE_URL + endpoint;

        if (url.indexOf(BASE_URL +
            '/api/v2/it_asset_management/') !== 0) {

            throw Error('Unexpected Zendesk API URL');
        }

        var response = https.get({
            url: url,
            headers: {
                Authorization: 'Bearer ' + token,
                Accept: 'application/json'
            }
        });

        var data;

        try {
            data = JSON.parse(response.body);
        } catch (e) {
            data = { raw: response.body };
        }

        log.audit('GET API RESPONSE', {
            endpoint: endpoint,
            httpCode: response.code
        });

        if (Number(response.code) !== 200) {

            log.error('GET API FAILED', {
                endpoint: endpoint,
                code: response.code,
                response: data
            });
        }

        return {
            code: Number(response.code),
            data: data
        };
    }

    // ================================================
    // GET ALL EXISTING ASSETS
    // ================================================
    function getExistingAssets(token) {

        var endpoint =
            '/api/v2/it_asset_management/assets?page[size]=50';

        var page = 0;
        var count = 0;
        var found = false;
        var completed = false;

        while (endpoint && page < 50) {

            page++;

            var result = getAPI(token, endpoint);

            if (result.code !== 200) {
                return {
                    success: false,
                    count: count,
                    exists: found
                };
            }

            var rows = result.data.assets || [];

            if (!Array.isArray(rows)) {
                log.error('INVALID ASSET RESPONSE', result.data);
                return {success: false};
            }

            for (var i = 0; i < rows.length; i++) {

                count++;

                var asset = rows[i];

                logData('EXISTING ZENDESK ASSET ' + count,
                    asset);

                if (
                    String(asset.external_id || '') ===
                        ASSET.external_id ||
                    (
                        asset.serial_number &&
                        asset.serial_number ===
                            ASSET.serial_number
                    )
                ) {

                    found = true;

                    log.audit('MATCHING ASSET FOUND', {
                        zendeskAssetId: asset.id,
                        name: asset.name,
                        externalId: asset.external_id,
                        serialNumber: asset.serial_number
                    });
                }
            }

            log.audit('ASSET PAGE RETRIEVED', {
                page: page,
                countOnPage: rows.length,
                totalRetrieved: count
            });

            var next = result.data.links &&
                result.data.links.next;

            if (next) {

                endpoint = next;

            } else if (
                result.data.meta &&
                result.data.meta.has_more
            ) {

                var cursor =
                    result.data.meta.after_cursor;

                if (!cursor) {
                    log.error('ASSET PAGINATION ERROR',
                        'Missing next cursor');
                    return {success: false};
                }

                endpoint =
                    '/api/v2/it_asset_management/assets' +
                    '?page[size]=50&page[after]=' +
                    encodeURIComponent(cursor);

            } else {

                endpoint = null;
                completed = true;
            }
        }

        if (!completed) {

            log.error('ASSET LIST INCOMPLETE', {
                pageLimit: 50,
                totalRetrieved: count
            });

            return {success: false};
        }

        log.audit('ALL ASSETS RETRIEVED', {
            totalAssets: count,
            pages: page,
            matchingAssetExists: found
        });

        return {
            success: true,
            count: count,
            exists: found
        };
    }

    // ================================================
    // GET ASSET TYPES
    // ================================================
    function getAssetTypes(token) {

        var result = getAPI(
            token,
            '/api/v2/it_asset_management/asset_types'
        );

        if (result.code !== 200) return false;

        var rows = result.data.asset_types || [];
        var found = false;

        for (var i = 0; i < rows.length; i++) {

            logData('ZENDESK ASSET TYPE ' + (i + 1),
                rows[i]);

            if (String(rows[i].id) === ASSET_TYPE_ID) {
                found = true;
                log.audit('BOT ASSET TYPE CONFIRMED', rows[i]);
            }
        }

        log.audit('ASSET TYPES TOTAL', {
            count: rows.length,
            botTypeFound: found
        });

        return found;
    }

    // ================================================
    // GET BOT ASSET FIELDS
    // ================================================
    function getAssetFields(token) {

        var endpoint =
            '/api/v2/it_asset_management/asset_types/' +
            ASSET_TYPE_ID + '/fields';

        var result = getAPI(token, endpoint);

        if (result.code !== 200) return false;

        logData('BOT ASSET FIELD DEFINITIONS',
            result.data);

        return true;
    }

    // ================================================
    // GET AVAILABLE ASSET STATUSES
    // ================================================
    function getStatusId(token) {

        var result = getAPI(
            token,
            '/api/v2/it_asset_management/statuses'
        );

        if (result.code !== 200) return null;

        var statuses = result.data.statuses || [];
        var selected = null;

        for (var i = 0; i < statuses.length; i++) {

            logData('ZENDESK ASSET STATUS ' + (i + 1),
                statuses[i]);

            if (
                (statuses[i].name || '').toLowerCase() ===
                'on lease'
            ) {
                selected = statuses[i];
            }
        }

        // If exact "On Lease" is unavailable,
        // select an existing In Use category status.
        if (!selected) {

            for (var j = 0; j < statuses.length; j++) {

                if (
                    (statuses[j].name || '').toLowerCase()
                        === 'in use'
                ) {
                    selected = statuses[j];
                    break;
                }
            }
        }

        if (!selected) {

            for (var k = 0; k < statuses.length; k++) {

                if (statuses[k].category === 'in_use') {
                    selected = statuses[k];
                    break;
                }
            }
        }

        if (!selected) {

            log.error('NO SUITABLE STATUS FOUND', {
                availableStatuses: statuses
            });

            return null;
        }

        log.audit('SELECTED ASSET STATUS', {
            id: selected.id,
            name: selected.name,
            category: selected.category,
            netsuiteStatus: 'On Lease'
        });

        return selected.id;
    }

    // ================================================
    // CREATE HARDCODED ZENDESK ASSET
    // ================================================
    function createAsset(token, statusId) {

        var payload = {
            asset: {
                name: ASSET.name,
                asset_type_id: ASSET_TYPE_ID,
                status_id: statusId,
                organization_id: ORGANIZATION_ID,
                serial_number: ASSET.serial_number,
                external_id: ASSET.external_id,
                model: ASSET.model,
                warranty_expiration:
                    ASSET.warranty_expiration,
                notes: ASSET.notes
            }
        };

        logData('ASSET CREATE PAYLOAD', payload);

        var response = https.post({
            url: BASE_URL +
                '/api/v2/it_asset_management/assets',
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
            result = { raw: response.body };
        }

        logData('ASSET CREATION API RESPONSE', {
            httpCode: response.code,
            result: result
        });

        if (
            Number(response.code) === 201 &&
            result.asset &&
            result.asset.id
        ) {

            log.audit('ZENDESK ASSET CREATED', {
                zendeskAssetId: result.asset.id,
                netsuiteAssetId: ASSET.external_id,
                assetName: result.asset.name,
                organizationId: ORGANIZATION_ID,
                statusId: statusId
            });

        } else {

            log.error('ZENDESK ASSET CREATION FAILED', {
                code: response.code,
                response: result
            });
        }
    }

    // ================================================
    // MAP REDUCE
    // ================================================
    function getInputData() {
        return [{ id: 224 }];
    }

    function map(context) {

        try {

            log.audit('ZENDESK ASSET TEST STARTED', {
                assetId: ASSET.external_id,
                createEnabled: CREATE_ENABLED,
                assetTypeId: ASSET_TYPE_ID,
                organizationId: ORGANIZATION_ID
            });

            // READ EXISTING ZENDESK DATA
            var readToken = getToken('read');

            if (!readToken) {
                log.error('TEST STOPPED',
                    'Unable to obtain Zendesk read token');
                return;
            }

            var existing = getExistingAssets(readToken);

            if (!existing.success) {
                log.error('TEST STOPPED',
                    'Existing assets could not be fully checked');
                return;
            }

            var typeFound = getAssetTypes(readToken);

            var fieldsOK = getAssetFields(readToken);

            var statusId = getStatusId(readToken);

            // READ-ONLY TEST MODE
            if (!CREATE_ENABLED) {

                log.audit('READ ONLY TEST FINISHED', {
                    existingAssetCount: existing.count,
                    matchingAssetExists: existing.exists,
                    botAssetTypeFound: typeFound,
                    assetFieldsRead: fieldsOK,
                    selectedStatusId: statusId,
                    creationAttempted: false
                });

                return;
            }

            // PREVENT DUPLICATE CREATION
            if (existing.exists) {
                log.audit('ASSET CREATION SKIPPED',
                    'Matching asset already exists');
                return;
            }

            if (!typeFound || !fieldsOK || !statusId) {
                log.error('ASSET CREATION SKIPPED',
                    'Asset type, fields or status unavailable');
                return;
            }

            // WRITE TOKEN
            var writeToken = getToken('write');

            if (!writeToken) {
                log.error('TEST STOPPED',
                    'Unable to obtain Zendesk write token');
                return;
            }

            // CREATE ONE TEST ASSET
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
