/**
 * @NApiVersion 2.1
 * @NScriptType MapReduceScript
 */
define(['N/https', 'N/log'], function(https, log) {

    var BASE_URL = 'https://mytra.zendesk.com';
    var CLIENT_ID = 'netsuite_fsm_integration';
    var CLIENT_SECRET = '4f1beaf8b4a16f576d75f7bc4d8e77d63ac1d07a23d6f4293036c4fe62ef5779';

    // =================================================
    // LOG COMPLETE DATA
    // =================================================
    function logData(title, data) {
        var value = JSON.stringify(data, null, 2) || 'null';
        var size = 3500;
        var parts = Math.ceil(value.length / size);

        for (var i = 0; i < parts; i++) {
            log.audit(
                title + ' PART ' + (i + 1) + '/' + parts,
                value.substring(i * size, (i + 1) * size)
            );
        }
    }

    // =================================================
    // GET TOKEN
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
            log.error('OAUTH ACCESS FAILED', {
                scope: scope,
                code: res.code,
                response: res.body
            });
            return null;
        }

        var data = JSON.parse(res.body);

        log.audit('OAUTH ACCESS SUCCESS', {
            requestedScope: scope,
            grantedScope: data.scope || '',
            hasToken: !!data.access_token
        });

        return data.access_token || null;
    }

    // =================================================
    // GET API
    // =================================================
    function getAPI(token, endpoint) {

        var url = endpoint.indexOf('https://') === 0
            ? endpoint : BASE_URL + endpoint;

        if (url.indexOf(BASE_URL + '/api/v2/') !== 0) {
            throw Error('Invalid Zendesk API URL');
        }

        var res = https.get({
            url: url,
            headers: {
                Authorization: 'Bearer ' + token,
                Accept: 'application/json'
            }
        });

        if (Number(res.code) !== 200) {
            log.error('API ACCESS FAILED', {
                endpoint: endpoint,
                code: res.code,
                response: res.body
            });
            return null;
        }

        return JSON.parse(res.body);
    }

    // =================================================
    // GET ALL RECORDS WITH PAGINATION
    // =================================================
    function getAll(token, endpoint, property, title) {

        var next = endpoint;
        var count = 0;
        var page = 0;

        while (next) {

            page++;

            var data = getAPI(token, next);
            if (!data) break;

            var rows = data[property] || [];

            for (var i = 0; i < rows.length; i++) {
                count++;
                logData(title + ' ' + count, rows[i]);
            }

            log.audit(title + ' PAGE', {
                page: page,
                pageCount: rows.length,
                total: count
            });

            next = data.next_page ||
                (data.links && data.links.next) ||
                null;
        }

        log.audit(title + ' TOTAL', count);
    }

    // =================================================
    // CHECK CREATE SCOPES
    // =================================================
    function checkPermissions() {

        var orgWrite = getToken('organizations:write');

        log.audit('ORGANIZATION CREATE SCOPE', {
            scopeGranted: !!orgWrite,
            createPermissionConfirmed: false,
            note: 'Role permission must also allow creation'
        });

        var assetWrite = getToken('custom_objects:write');

        log.audit('ASSET CREATE SCOPE', {
            scopeGranted: !!assetWrite,
            createPermissionConfirmed: false,
            note: 'Check object-specific role permissions'
        });
    }

    // =================================================
    // GET ORGANIZATIONS
    // =================================================
    function getOrganizations(token) {

        getAll(
            token,
            '/api/v2/organizations.json',
            'organizations',
            'EXISTING ORGANIZATION'
        );

        getAll(
            token,
            '/api/v2/organization_fields.json',
            'organization_fields',
            'ORGANIZATION FIELD'
        );

        log.audit('ORGANIZATION CREATE DETAILS', {
            endpoint: 'POST /api/v2/organizations.json',
            required: ['name'],
            additionalFields: 'See organization field logs'
        });
    }

    // =================================================
    // GET ASSETS AND ASSET FIELDS
    // =================================================
    function getAssets(token) {

        var data = getAPI(
            token,
            '/api/v2/custom_objects'
        );

        if (!data) return;

        var objects = data.custom_objects || [];
        var found = 0;

        for (var i = 0; i < objects.length; i++) {

            var obj = objects[i];

            logData('CUSTOM OBJECT', obj);

            var name = (
                (obj.key || '') + ' ' +
                (obj.title || '') + ' ' +
                (obj.title_pluralized || '')
            ).toLowerCase();

            if (name.indexOf('asset') === -1) continue;

            found++;

            var key = encodeURIComponent(obj.key);
            var base = '/api/v2/custom_objects/' + key;

            log.audit('ASSET OBJECT FOUND', {
                key: obj.key,
                name: obj.title
            });

            getAll(
                token,
                base + '/records',
                'custom_object_records',
                'EXISTING ASSET'
            );

            getAll(
                token,
                base + '/fields?include_standard_fields=true',
                'custom_object_fields',
                'ASSET FIELD'
            );

            var metadata = getAPI(
                token,
                base + '?include_permissions_metadata=true'
            );

            if (metadata) {
                logData('ASSET PERMISSION METADATA', metadata);
            }

            var permissions = getAPI(
                token,
                base + '/permission_policies'
            );

            if (permissions) {
                logData('ASSET ROLE PERMISSIONS', permissions);
            }

            log.audit('ASSET CREATE DETAILS', {
                objectKey: obj.key,
                endpoint: 'POST ' + base + '/records',
                required: 'See ASSET FIELD logs',
                permissions: 'See ASSET ROLE PERMISSIONS'
            });
        }

        log.audit('ASSET OBJECT COUNT', found);

        if (!found) {
            log.audit(
                'NO ASSET OBJECT',
                'No custom object with asset in its name or key'
            );
        }
    }

    // =================================================
    // GET EXISTING AGENTS
    // =================================================
    function getAgents(token) {

        getAll(
            token,
            '/api/v2/users.json?role%5B%5D=agent&role%5B%5D=admin',
            'users',
            'EXISTING AGENT'
        );
    }

    // =================================================
    // MAP REDUCE
    // =================================================
    function getInputData() {
        return [{ id: 1 }];
    }

    function map(context) {

        try {

            log.audit('ZENDESK AUDIT STARTED', BASE_URL);

            var token = getToken(
                'organizations:read users:read'
            );

            if (token) {

                var currentUser = getAPI(
                    token,
                    '/api/v2/users/me.json'
                );

                if (currentUser) {
                    logData('AUTHENTICATED USER', currentUser.user);
                }

                getOrganizations(token);
                getAgents(token);
            }

            var assetToken = getToken('custom_objects:read');

            if (assetToken) {
                getAssets(assetToken);
            }

            checkPermissions();

            log.audit(
                'ZENDESK AUDIT COMPLETED',
                'All available checks finished'
            );

        } catch (e) {

            log.error('ZENDESK AUDIT ERROR', {
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

        log.audit('FINAL SUMMARY', {
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
