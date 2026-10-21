
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

    // Current working scope
    // After admin adds read scopes, change to:
    // 'tickets:read organizations:read users:read'
    const SCOPE = 'tickets:read organizations:read users:read';

    const MAX_TICKETS = 5;
    const MAX_LOG_LENGTH = 3000;

    // Avoid calling the same user/org twice
    const orgCache = {};
    const userCache = {};

    // ==========================================
    // LOG FULL JSON IN CHUNKS
    // ==========================================

    function logJSON(title, data) {

        const json = JSON.stringify(data, null, 2);

        if (!json) {
            log.audit(title, 'Empty response');
            return;
        }

        const parts = Math.ceil(
            json.length / MAX_LOG_LENGTH
        );

        for (let i = 0; i < parts; i++) {

            log.audit(
                title + ' - Part ' + (i + 1) + '/' + parts,
                json.substring(
                    i * MAX_LOG_LENGTH,
                    (i + 1) * MAX_LOG_LENGTH
                )
            );
        }
    }

    // ==========================================
    // GENERATE ACCESS TOKEN
    // ==========================================

    function getAccessToken() {

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

        if (Number(response.code) !== 200 &&
            Number(response.code) !== 201) {

            throw new Error(
                'OAuth failed. HTTP: ' + response.code +
                '. Check credentials and scopes.'
            );
        }

        const data = JSON.parse(response.body);

        if (!data.access_token) {
            throw new Error('Access token not found');
        }

        log.audit(
            'OAuth Authentication Success',
            'Access token generated'
        );

        return data.access_token;
    }

    // ==========================================
    // GENERIC ZENDESK GET API
    // ==========================================

    function callZendeskAPI(token, endpoint, title) {

        try {

            const response = https.get({
                url: BASE_URL + endpoint,
                headers: {
                    'Authorization': 'Bearer ' + token,
                    'Accept': 'application/json'
                }
            });

            log.audit(title + ' - HTTP Status', response.code);

            if (Number(response.code) !== 200) {

                log.error(title + ' - API Error', {
                    status: response.code,
                    endpoint: endpoint,
                    message: Number(response.code) === 403
                        ? 'Check OAuth read scope and service account permissions'
                        : 'Zendesk GET request failed'
                });

                return null;
            }

            const data = JSON.parse(response.body);

            logJSON(title + ' - FULL RESPONSE', data);

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
            return;
        }

        if (Object.prototype.hasOwnProperty.call(
            orgCache, String(orgId)
        )) {
            log.debug(
                'Organization Already Fetched',
                orgId
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
            log.debug(
                role + ' Not Available',
                'User ID is empty'
            );
            return;
        }

        log.audit(
            'Fetching ' + role,
            'User ID: ' + userId
        );

        if (Object.prototype.hasOwnProperty.call(
            userCache, String(userId)
        )) {
            log.debug(
                'User Already Fetched',
                'User ID: ' + userId
            );
            return;
        }

        const result = callZendeskAPI(
            token,
            '/api/v2/users/' + userId + '.json',
            'User ' + userId
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

            // STEP 1: OAuth Authentication
            const token = getAccessToken();

            // STEP 2: Fetch Tickets
            const ticketData = callZendeskAPI(
                token,
                '/api/v2/tickets.json?per_page=' + MAX_TICKETS,
                'Zendesk Tickets'
            );

            if (!ticketData || !ticketData.tickets) {

                log.error(
                    'Tickets Not Found',
                    'No ticket data returned'
                );

                return [];
            }

            const tickets = ticketData.tickets;

            log.audit(
                'Total Tickets Retrieved',
                tickets.length
            );

            // STEP 3: Process Each Ticket
            tickets.forEach((ticket, index) => {

                log.audit(
                    'Processing Ticket ' + (index + 1),
                    'Ticket ID: ' + ticket.id
                );

                // Full ticket JSON already logged above

                // STEP 4: Get Organization
                getOrganization(
                    token,
                    ticket.organization_id
                );

                // STEP 5: Get Requester
                getUser(
                    token,
                    ticket.requester_id,
                    'Requester'
                );

                // STEP 6: Get Assignee
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
                ' tickets and attempted related organization/user lookups'
            );

        } catch (error) {

            log.error('Zendesk Integration Error', {
                name: error.name,
                message: error.message
            });

        }

        return [];
    }

    // Required Map/Reduce function
    function map(context) {

        log.debug(
            'Map Stage',
            'Not required for this API test'
        );

    }

    return {
        getInputData: getInputData,
        map: map
    };

});
