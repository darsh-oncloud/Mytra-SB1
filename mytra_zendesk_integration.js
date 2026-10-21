/**
 * @NApiVersion 2.1
 * @NScriptType MapReduceScript
 */

define(['N/https', 'N/log'], (https, log) => {

    // ==========================================
    // HARDCODED ZENDESK CREDENTIALS
    // ==========================================

    const BASE_URL = 'https://mytra.zendesk.com';
    const CLIENT_ID = 'netsuite_fsm_integration';
    const CLIENT_SECRET = '4f1beaf8b4a16f576d75f7bc4d8e77d63ac1d07a23d6f4293036c4fe62ef5779';

    const SCOPE = 'tickets:read';

    // ==========================================
    // GET INPUT DATA
    // ==========================================

    function getInputData() {

        try {

            log.audit(
                'Zendesk Test Started',
                'Connecting to: ' + BASE_URL
            );

            // STEP 1: GENERATE OAUTH ACCESS TOKEN

            const tokenResponse = https.post({
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

            log.audit(
                'OAuth HTTP Status',
                tokenResponse.code
            );

            if (Number(tokenResponse.code) !== 200 &&
                Number(tokenResponse.code) !== 201) {

                log.error('OAuth Authentication Failed', {
                    status: tokenResponse.code,
                    message: 'Check domain, client credentials, grant type and scope'
                });

                return [];
            }

            const tokenData = JSON.parse(tokenResponse.body);

            if (!tokenData.access_token) {

                log.error(
                    'OAuth Error',
                    'Access token not found in response'
                );

                return [];
            }

            log.audit(
                'OAuth Authentication Success',
                'Access token generated successfully'
            );

            // STEP 2: GET ZENDESK TICKETS

            const ticketResponse = https.get({
                url: BASE_URL + '/api/v2/tickets.json?per_page=5',
                headers: {
                    'Authorization': 'Bearer ' + tokenData.access_token,
                    'Accept': 'application/json'
                }
            });

            log.audit(
                'Zendesk Tickets HTTP Status',
                ticketResponse.code
            );

            if (Number(ticketResponse.code) !== 200) {

                log.error('Zendesk Ticket API Failed', {
                    status: ticketResponse.code,
                    response: (ticketResponse.body || '').substring(0, 2000)
                });

                return [];
            }

            // STEP 3: PARSE RESPONSE

            const result = JSON.parse(ticketResponse.body);
            const tickets = result.tickets || [];

            log.audit(
                'Total Tickets Retrieved',
                tickets.length
            );

            // STEP 4: LOG TICKET DETAILS

            tickets.forEach((ticket, index) => {

                log.audit(
                    'Zendesk Ticket ' + (index + 1),
                    JSON.stringify({
                        id: ticket.id,
                        subject: ticket.subject,
                        status: ticket.status,
                        priority: ticket.priority,
                        type: ticket.type,
                        requester_id: ticket.requester_id,
                        assignee_id: ticket.assignee_id,
                        organization_id: ticket.organization_id,
                        created_at: ticket.created_at,
                        updated_at: ticket.updated_at
                    })
                );

            });

            log.audit(
                'Zendesk Test Completed',
                'Successfully retrieved ' +
                tickets.length + ' tickets'
            );

        } catch (error) {

            log.error('Zendesk Integration Error', {
                name: error.name,
                message: error.message
            });

        }

        return [];
    }

    // ==========================================
    // MAP FUNCTION - REQUIRED BY NETSUITE
    // ==========================================

    function map(context) {

        log.debug(
            'Map Stage',
            'No processing required for API test'
        );

    }

    // ==========================================
    // RETURN FUNCTIONS
    // ==========================================

    return {
        getInputData: getInputData,
        map: map
    };

});
