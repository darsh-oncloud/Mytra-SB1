/**
 * @NApiVersion 2.1
 * @NScriptType MapReduceScript
 */

define(['N/https', 'N/log'], (https, log) => {

    // ==========================================
    // ZENDESK CONFIGURATION
    // ==========================================

    const BASE_URL = 'https://mytra.zendesk.com';
    const CLIENT_ID = 'netsuite_fsm_integration';
    const CLIENT_SECRET = '4f1beaf8b4a16f576d75f7bc4d8e77d63ac1d07a23d6f4293036c4fe62ef5779';

    // First test with the existing working scope.
    // After the administrator adds read permissions:
    // 'tickets:read organizations:read users:read'
    const SCOPE = 'tickets:read organizations:read users:read';

    const MAX_TICKETS = 5;
    const MAX_LOG_LENGTH = 3000;

    // Avoid duplicate lookups for the same IDs.
    const orgCache = {};
    const userCache = {};

    // ==========================================
    // SAFE ERROR LOGGING
    // ==========================================

    function safeErrorBody(body) {

        if (!body) {
            return 'Empty response body';
        }

        try {
            const parsed = JSON.parse(body);

            function redact(value) {

                if (Array.isArray(value)) {
                    return value.map(redact);
                }

                if (value && typeof value === 'object') {

                    const result = {};

                    Object.keys(value).forEach(key => {

                        if (/token|secret|password|authorization|cookie|credential|api_key/i.test(key)) {
                            result[key] = '[REDACTED]';
                        } else {
                            result[key] = redact(value[key]);
                        }
                    });

                    return result;
                }

                return value;
            }

            return JSON.stringify(redact(parsed))
                .substring(0, MAX_LOG_LENGTH);

        } catch (e) {

            return '[Non-JSON error response omitted for security]';
        }
    }

    // ==========================================
    // LOG SUCCESSFUL JSON IN CHUNKS
    // ==========================================

    function logJSON(title, data) {

        const json = JSON.stringify(data, null, 2);

        if (!json) {
            log.audit(title, 'Empty response');
            return;
        }

        const totalParts = Math.ceil(
            json.length / MAX_LOG_LENGTH
        );

        for (let i = 0; i < totalParts; i++) {

            log.audit(
                title + ' - Part ' + (i + 1) +
                '/' + totalParts,
                json.substring(
                    i * MAX_LOG_LENGTH,
                    (i + 1) * MAX_LOG_LENGTH
                )
            );
        }
    }

    // ==========================================
    // GENERATE OAUTH ACCESS TOKEN
    // ==========================================

    function getAccessToken() {

        log.audit('OAuth Request', {
            endpoint: BASE_URL + '/oauth/tokens',
            grantType: 'client_credentials',
            requestedScope: SCOPE
        });

        const response = https.post({
            url: BASE_URL + '/oauth/tokens',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            },
            body: JSON.stringify({
                grant_type: 'client_credentials',
                client_id: CLIENT_ID,
                client_secret: CLIENT_SECRET,
                scope: SCOPE
            })
        });

        log.audit('OAuth HTTP Status', response.code);

        if (Number(response.code) < 200 ||
            Number(response.code) >= 300) {

            log.error('OAuth FULL ERROR RESPONSE', {
                status: response.code,
                requestedScope: SCOPE,
                responseBody: safeErrorBody(response.body)
            });

            throw new Error(
                'OAuth authentication failed. HTTP ' +
                response.code +
                '. Review OAuth FULL ERROR RESPONSE log.'
            );
        }

        const tokenData = JSON.parse(response.body);

        if (!tokenData.access_token) {

            log.error(
                'OAuth Missing Access Token',
                'OAuth response did not contain access_token'
            );

            throw new Error('Access token not returned');
        }

        log.audit('OAuth Authentication Success', {
            status: response.code,
            grantedScope: tokenData.scope || 'Not returned'
        });

        return tokenData.access_token;
    }

    // ==========================================
    // GENERIC ZENDESK GET REQUEST
    // ==========================================

    function callZendeskAPI(token, endpoint, title) {

        try {

            log.audit(title + ' - Request', {
                method: 'GET',
                endpoint: endpoint
            });

            const response = https.get({
                url: BASE_URL + endpoint,
                headers: {
                    'Authorization': 'Bearer ' + token,
                    'Accept': 'application/json'
                }
            });

            log.audit(
                title + ' - HTTP Status',
                response.code
            );

            if (Number(response.code) < 200 ||
                Number(response.code) >= 300) {

                log.error(
                    title + ' - FULL ERROR RESPONSE',
                    {
                        status: response.code,
                        endpoint: endpoint,
                        responseBody: safeErrorBody(
                            response.body
                        )
                    }
                );

                return null;
            }

            const data = JSON.parse(response.body);

            logJSON(
                title + ' - FULL RESPONSE',
                data
            );

            return data;

        } catch (error) {

            log.error(title + ' - Exception', {
                name: error.name,
                message: error.message
            });

            return null;
        }
    }

    // ==========================================
    // GET ORGANIZATION DETAILS
    // ==========================================

    function getOrganization(token, orgId) {

        if (!orgId) {
            log.audit(
                'Organization Skipped',
                'Organization ID is empty'
            );
            return;
        }

        if (Object.prototype.hasOwnProperty.call(
            orgCache, String(orgId)
        )) {
            log.debug(
                'Organization Already Attempted',
                'Organization ID: ' + orgId
            );
            return;
        }

        log.audit(
            'Fetching Organization',
            'Organization ID: ' + orgId
        );

        const result = callZendeskAPI(
            token,
            '/api/v2/organizations/' + orgId + '.json',
            'Organization ' + orgId
        );

        orgCache[orgId] = result;
    }

    // ==========================================
    // GET USER DETAILS
    // ==========================================

    function getUser(token, userId, role) {

        if (!userId) {
            log.audit(
                role + ' Skipped',
                'User ID is empty'
            );
            return;
        }

        if (Object.prototype.hasOwnProperty.call(
            userCache, String(userId)
        )) {
            log.debug(
                'User Already Attempted',
                'User ID: ' + userId
            );
            return;
        }

        log.audit(
            'Fetching ' + role,
            'User ID: ' + userId
        );

        const result = callZendeskAPI(
            token,
            '/api/v2/users/' + userId + '.json',
            role + ' User ' + userId
        );

        userCache[userId] = result;
    }

    // ==========================================
    // GET INPUT DATA
    // ==========================================

    function getInputData() {

        try {

            log.audit(
                'Zendesk Test Started',
                'Connecting to ' + BASE_URL
            );

            // STEP 1: Authenticate
            const token = getAccessToken();

            // STEP 2: Retrieve tickets
            const ticketData = callZendeskAPI(
                token,
                '/api/v2/tickets.json?per_page=' + MAX_TICKETS,
                'Zendesk Tickets'
            );

            if (!ticketData ||
                !Array.isArray(ticketData.tickets)) {

                log.error(
                    'Tickets Not Retrieved',
                    'Ticket request failed or returned unexpected data'
                );

                return [];
            }

            const tickets = ticketData.tickets;

            log.audit(
                'Total Tickets Retrieved',
                tickets.length
            );

            // STEP 3: Retrieve related records
            tickets.forEach((ticket, index) => {

                log.audit(
                    'Processing Ticket ' + (index + 1),
                    {
                        ticketId: ticket.id,
                        subject: ticket.subject,
                        organizationId: ticket.organization_id,
                        requesterId: ticket.requester_id,
                        assigneeId: ticket.assignee_id
                    }
                );

                // Organization
                getOrganization(
                    token,
                    ticket.organization_id
                );

                // Requester
                getUser(
                    token,
                    ticket.requester_id,
                    'Requester'
                );

                // Assignee
                getUser(
                    token,
                    ticket.assignee_id,
                    'Assignee'
                );

                log.audit(
                    'Ticket Processing Completed',
                    'Ticket ID: ' + ticket.id
                );
            });

            log.audit(
                'Zendesk Test Completed',
                'Processed ' + tickets.length +
                ' tickets and attempted related record lookups.'
            );

        } catch (error) {

            log.error('Zendesk Integration Error', {
                name: error.name,
                message: error.message
            });
        }

        return [];
    }

    // Required for NetSuite Map/Reduce validation.
    // No map processing is needed for this test.
    function map(context) {
        log.debug(
            'Map Stage',
            'No processing required'
        );
    }

    return {
        getInputData: getInputData,
        map: map
    };

});
