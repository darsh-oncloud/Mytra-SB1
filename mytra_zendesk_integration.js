
/**
 * @NApiVersion 2.1
 * @NScriptType MapReduceScript
 */
define(['N/https', 'N/record', 'N/search', 'N/log'],
(https, record, search, log) => {

    const BASE_URL = 'https://mytra.zendesk.com';
    const CLIENT_ID = 'netsuite_fsm_integration';

    // Use a newly rotated secret. Never put the real
    // secret in logs or share it in code.
    // Temporary Sandbox setup only.
    const CLIENT_SECRET = 'REPLACE_WITH_ROTATED_SECRET';

    const SCOPE = 'tickets:read organizations:read users:read';

    const orgCache = {};
    const userCache = {};

    // =================================================
    // ZENDESK AUTHENTICATION
    // =================================================
    const getToken = () => {
        const res = https.post({
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

        if (Number(res.code) !== 200) {
            throw Error('Zendesk OAuth failed: HTTP ' + res.code);
        }

        const data = JSON.parse(res.body);

        if (!data.access_token) {
            throw Error('Zendesk OAuth token missing');
        }

        log.audit('Zendesk OAuth Success', 'Connected');
        return data.access_token;
    };

    // =================================================
    // GENERIC ZENDESK GET
    // =================================================
    const getAPI = (token, endpoint) => {
        const url = endpoint.startsWith('https://')
            ? endpoint
            : BASE_URL + endpoint;

        if (!url.startsWith(BASE_URL + '/api/v2/')) {
            throw Error('Unexpected Zendesk API URL');
        }

        const res = https.get({
            url,
            headers: {
                Authorization: 'Bearer ' + token,
                Accept: 'application/json'
            }
        });

        if (Number(res.code) !== 200) {
            throw Error(
                'Zendesk GET failed: HTTP ' + res.code +
                ' - ' + endpoint
            );
        }

        return JSON.parse(res.body);
    };

    // =================================================
    // GET ORGANIZATION
    // =================================================
    const getOrganization = (token, id) => {
        if (!id) return null;

        if (!Object.prototype.hasOwnProperty.call(
            orgCache, String(id)
        )) {
            const data = getAPI(
                token,
                '/api/v2/organizations/' + id + '.json'
            );

            orgCache[id] = data.organization || null;
        }

        return orgCache[id];
    };

    // =================================================
    // GET ZENDESK USER
    // =================================================
    const getUser = (token, id) => {
        if (!id) return null;

        if (!Object.prototype.hasOwnProperty.call(
            userCache, String(id)
        )) {
            const data = getAPI(
                token,
                '/api/v2/users/' + id + '.json'
            );

            userCache[id] = data.user || null;
        }

        return userCache[id];
    };

    // =================================================
    // INPUT: RETRIEVE ALL ZENDESK TICKETS
    // =================================================
    const getInputData = () => {
        const token = getToken();
        const tickets = [];

        let next = '/api/v2/tickets.json?per_page=100';
        let page = 0;

        while (next) {
            page++;

            const data = getAPI(token, next);

            if (!Array.isArray(data.tickets)) {
                throw Error('Unexpected ticket API response');
            }

            data.tickets.forEach(t => {
                // Skip deleted tickets.
                if (t.status === 'deleted') return;

                const org = getOrganization(
                    token, t.organization_id
                );

                const requester = getUser(
                    token, t.requester_id
                );

                const assignee = getUser(
                    token, t.assignee_id
                );

                tickets.push({
                    ticket: t,
                    organization: org,
                    requester,
                    assignee
                });
            });

            log.audit('Zendesk Page Retrieved', {
                page,
                ticketsOnPage: data.tickets.length,
                totalTickets: tickets.length
            });

            next = data.next_page || null;
        }

        log.audit('Zendesk Retrieval Completed', {
            totalTickets: tickets.length,
            pages: page
        });

        return tickets;
    };

    // =================================================
    // FIND NETSUITE EMPLOYEE BY EMAIL
    // =================================================
    const findEmployee = (email) => {
        if (!email) return null;

        const results = search.create({
            type: search.Type.EMPLOYEE,
            filters: [
                ['email', 'is', email],
                'AND',
                ['isinactive', 'is', 'F']
            ],
            columns: ['internalid']
        }).run().getRange({start: 0, end: 2});

        return results.length === 1
            ? Number(results[0].id)
            : null;
    };

    // =================================================
    // FIND NETSUITE CUSTOMER BY COMPANY NAME
    // =================================================
    const findCustomer = (name) => {
        if (!name) return null;

        const results = search.create({
            type: search.Type.CUSTOMER,
            filters: [
                ['companyname', 'is', name],
                'AND',
                ['isinactive', 'is', 'F']
            ],
            columns: ['internalid']
        }).run().getRange({start: 0, end: 2});

        return results.length === 1
            ? Number(results[0].id)
            : null;
    };

    // =================================================
    // FIND EXISTING TASK
    // =================================================
    const findTask = (ticketId) => {
        const titlePrefix = '[Zendesk #' + ticketId + ']';

        const results = search.create({
            type: search.Type.TASK,
            filters: [
                ['title', 'startswith', titlePrefix]
            ],
            columns: ['internalid']
        }).run().getRange({start: 0, end: 1});

        return results.length
            ? results[0].id
            : null;
    };

    // =================================================
    // MAP PRIORITY
    // =================================================
    const mapPriority = (value) => {
        switch (value) {
            case 'low': return 'LOW';
            case 'high':
            case 'urgent': return 'HIGH';
            default: return 'MEDIUM';
        }
    };

    // =================================================
    // MAP: CREATE NETSUITE TASK
    // =================================================
    const map = (context) => {
        const data = JSON.parse(context.value);
        const t = data.ticket;
        const org = data.organization;
        const requester = data.requester;
        const assignee = data.assignee;

        try {
            // Check existing task
            const existingId = findTask(t.id);

            if (existingId) {
                log.audit('TASK SKIPPED - EXISTS', {
                    zendeskId: t.id,
                    netsuiteTaskId: existingId
                });

                context.write({
                    key: 'skipped',
                    value: String(t.id)
                });
                return;
            }

            // Find related NetSuite records
            const employeeId = assignee
                ? findEmployee(assignee.email)
                : null;

            const customerId = org
                ? findCustomer(org.name)
                : null;

            // Prepare description
            const details = [
                '--- ZENDESK TICKET ---',
                'Ticket ID: ' + t.id,
                'Subject: ' + (t.subject || ''),
                'Description: ' + (t.description || ''),
                'Status: ' + (t.status || ''),
                'Type: ' + (t.type || ''),
                'Priority: ' + (t.priority || ''),
                'Created: ' + (t.created_at || ''),
                'Updated: ' + (t.updated_at || ''),

                '',
                '--- ORGANIZATION ---',
                'Name: ' + (org ? org.name : ''),
                'Organization ID: ' + (t.organization_id || ''),

                '',
                '--- REQUESTER ---',
                'Name: ' + (requester ? requester.name : ''),
                'Email: ' + (requester ? requester.email : ''),

                '',
                '--- ASSIGNEE ---',
                'Name: ' + (assignee ? assignee.name : 'Unassigned'),
                'Email: ' + (assignee ? assignee.email : ''),
                'NetSuite Employee ID: ' + (employeeId || ''),

                '',
                'Group ID: ' + (t.group_id || ''),
                'Zendesk URL: ' + BASE_URL +
                    '/agent/tickets/' + t.id
            ].join('\n');

            // Create CRM Task
            const task = record.create({
                type: record.Type.TASK,
                isDynamic: false
            });

            task.setValue({
                fieldId: 'title',
                value: '[Zendesk #' + t.id + '] ' +
                    (t.subject || 'No Subject')
            });

            task.setValue({
                fieldId: 'message',
                value: details
            });

            task.setValue({
                fieldId: 'priority',
                value: mapPriority(t.priority)
            });

            // Initial import: no automatic FSM closure.
            task.setValue({
                fieldId: 'status',
                value: 'NOTSTART'
            });

            task.setValue({
                fieldId: 'sendemail',
                value: false
            });

            if (employeeId) {
                task.setValue({
                    fieldId: 'assigned',
                    value: employeeId
                });
            }

            if (customerId) {
                task.setValue({
                    fieldId: 'company',
                    value: customerId
                });
            }

            const taskId = task.save({
                enableSourcing: true,
                ignoreMandatoryFields: false
            });

            log.audit('NETSUITE TASK CREATED', {
                zendeskId: t.id,
                taskId,
                title: t.subject,
                organization: org ? org.name : '',
                customerId: customerId || '',
                assignee: assignee ? assignee.name : '',
                employeeId: employeeId || ''
            });

            context.write({
                key: 'created',
                value: String(taskId)
            });

        } catch (e) {
            log.error('TASK CREATION FAILED', {
                zendeskId: t.id,
                name: e.name,
                message: e.message
            });

            throw e;
        }
    };

    // =================================================
    // SUMMARY
    // =================================================
    const summarize = (summary) => {
        let created = 0;
        let skipped = 0;
        let failed = 0;

        summary.output.iterator().each((key) => {
            if (key === 'created') created++;
            if (key === 'skipped') skipped++;
            return true;
        });

        summary.mapSummary.errors.iterator().each(
            (key, error) => {
                failed++;
                log.error('Map Error - ' + key, error);
                return true;
            }
        );

        if (summary.inputSummary.error) {
            log.error(
                'Zendesk Input Error',
                summary.inputSummary.error
            );
        }

        log.audit('ZENDESK TASK SYNC COMPLETED', {
            created,
            skipped,
            failed
        });
    };

    return {getInputData, map, summarize};
});
