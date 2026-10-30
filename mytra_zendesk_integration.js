/**
 * @NApiVersion 2.1
 * @NScriptType MapReduceScript
 *
 * Zendesk OAuth scope checker (read only - changes nothing in Zendesk)
 * Requests a client_credentials token for each scope, one by one,
 * and logs which scopes the OAuth client is allowed to use.
 */
define(['N/https', 'N/log'], function (https, log) {

    var BASE_URL = 'https://mytra.zendesk.com';
    var CLIENT_ID = 'netsuite_fsm_integration';
    var CLIENT_SECRET = '4f1beaf8b4a16f576d75f7bc4d8e77d63ac1d07a23d6f4293036c4fe62ef5779';

    // Scopes to test. The last few are guesses for IT Asset Management;
    // if Zendesk doesn't know a scope it simply reports it as not allowed.
    var SCOPES = [
        'read', 'write', 'impersonate',
        'tickets:read', 'tickets:write',
        'users:read', 'users:write',
        'organizations:read', 'organizations:write',
        'custom_objects:read', 'custom_objects:write',
        'macros:read', 'macros:write',
        'triggers:read', 'triggers:write',
        'automations:read', 'automations:write',
        'webhooks:read', 'webhooks:write',
        'targets:read', 'targets:write',
        'requests:read', 'requests:write',
        'hc:read', 'hc:write',
        'apps:read', 'apps:write',
        'satisfaction_ratings:read', 'satisfaction_ratings:write',
        'dynamic_content:read', 'dynamic_content:write',
        'auditlogs:read', 'security:read',
        'zis:read', 'zis:write',
        'assets:read', 'assets:write',
        'it_asset_management:read', 'it_asset_management:write'
    ];

    function tryScope(scope) {
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
        var data = {};
        try { data = JSON.parse(res.body); } catch (e) { data = { raw: res.body }; }

        return {
            scope: scope,
            allowed: Number(res.code) === 200 && !!data.access_token,
            code: Number(res.code),
            granted: data.scope || '',
            error: data.error || '',
            token: data.access_token || null
        };
    }

    // Shows the token's own details (scopes, user it runs as) - informational
    function showCurrentToken(token) {
        var res = https.get({
            url: BASE_URL + '/api/v2/oauth/tokens/current.json',
            headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' }
        });
        log.audit('CURRENT TOKEN INFO (HTTP ' + res.code + ')',
            String(res.body).substring(0, 3800));
    }

    function getInputData() { return [{ id: 1 }]; }

    function map(context) {
        var allowed = [];
        var denied = [];
        var anyToken = null;

        for (var i = 0; i < SCOPES.length; i++) {
            var r = tryScope(SCOPES[i]);

            if (r.allowed) {
                allowed.push(r.scope);
                if (!anyToken) anyToken = r.token;
            } else {
                denied.push(r.scope + ' (' + r.code + ' ' + r.error + ')');
            }

            // Stop early if the client itself is rejected (wrong id/secret)
            if (r.error === 'invalid_client') {
                log.error('CLIENT REJECTED', 'Check CLIENT_ID / CLIENT_SECRET');
                return;
            }
        }

        log.audit('ALLOWED SCOPES (' + allowed.length + ')', allowed.join(', ') || 'none');
        log.audit('NOT ALLOWED SCOPES (' + denied.length + ')', denied.join(', ').substring(0, 3800));

        if (anyToken) showCurrentToken(anyToken);
    }

    function summarize(summary) {
        summary.mapSummary.errors.iterator().each(function (key, err) {
            log.error('MAP ERROR ' + key, err);
            return true;
        });
        log.audit('SCOPE CHECK FINISHED', { usage: summary.usage, seconds: summary.seconds });
    }

    return { getInputData: getInputData, map: map, summarize: summarize };
});