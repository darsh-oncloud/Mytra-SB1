/**
 * @NApiVersion 2.1
 * @NScriptType MapReduceScript
 * @NModuleScope SameAccount
 *
 * ZENDESK TICKET DISCOVERY (READ-ONLY)
 * Creates nothing in Zendesk or NetSuite. Logs (Execution Log):
 *
 *   TICKET FIELDS   every ticket field: id | title | type | target (lookups) | active
 *   TICKET STATS    over all tickets: totals, by status, with organization / requester,
 *                   and for EVERY field: how many tickets have a value + sample values
 *   SAMPLE TICKETS  a few raw tickets (preferring ones that have an asset), with the
 *                   requester's organization, so you can see exactly what Zendesk sends
 *
 * No script parameters: set the constants below.
 */
define(['N/https', 'N/log'], function (https, log) {

    var ZD = {
        BASE_URL: 'https://mytra.zendesk.com',
        CLIENT_ID: 'netsuite_fsm_integration',
        CLIENT_SECRET: '4f1beaf8b4a16f576d75f7bc4d8e77d63ac1d07a23d6f4293036c4fe62ef5779',
        SCOPE: 'read'
    };

    var TEST_TICKET_ID = '';   // e.g. '11' -> also logs that one ticket in full
    var SAMPLE_COUNT = 5;      // raw sample tickets to log
    var MAX_PAGES = 200;       // safety limit for reading tickets (1000 per page)

    // ---------------------------------------------------------------
    function parse(b) { try { return JSON.parse(b); } catch (e) { return { raw: b }; } }

    function token() {
        var s = ZD.CLIENT_SECRET;
        if (!s || s.indexOf('PASTE_') === 0) throw Error('Set ZD.CLIENT_SECRET at the top of the script');
        var res = https.post({
            url: ZD.BASE_URL + '/oauth/tokens',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({ grant_type: 'client_credentials', client_id: ZD.CLIENT_ID,
                                   client_secret: s, scope: ZD.SCOPE })
        });
        var d = parse(res.body);
        if (Number(res.code) !== 200 || !d.access_token) throw Error('OAuth failed: ' + res.code + ' ' + res.body);
        return d.access_token;
    }

    function zget(tok, urlOrPath) {
        var url = urlOrPath.indexOf('http') === 0 ? urlOrPath : ZD.BASE_URL + urlOrPath;
        var res = https.get({ url: url, headers: { Authorization: 'Bearer ' + tok, Accept: 'application/json' } });
        var d = parse(res.body);
        if (Number(res.code) !== 200) {
            log.error('Zendesk GET ' + urlOrPath, { httpCode: res.code, response: d });
            return null;
        }
        return d;
    }

    // log long text in chunks (Execution Log detail max ~3999 chars)
    function logChunks(title, lines) {
        var chunk = '', part = 1;
        lines.forEach(function (ln) {
            if ((chunk + ln).length > 3800) { log.audit(title + ' part ' + part++, chunk); chunk = ''; }
            chunk += ln + '\n';
        });
        if (chunk) log.audit(title + ' part ' + part, chunk);
    }

    function short(v) {
        var s = typeof v === 'string' ? v : JSON.stringify(v);
        return s.length > 60 ? s.slice(0, 57) + '...' : s;
    }

    function hasValue(v) {
        return !(v === null || v === undefined || v === '' || v === false ||
                 (Array.isArray(v) && !v.length));
    }

    // ---------------------------------------------------------------
    function fieldsSection(tok) {
        var fields = [], url = '/api/v2/ticket_fields.json?per_page=100';
        while (url) {
            var d = zget(tok, url);
            if (!d) break;
            fields = fields.concat(d.ticket_fields || []);
            url = d.next_page || '';
        }
        var lines = fields.map(function (f) {
            return [f.id, f.title, f.type,
                    f.relationship_target_type ? 'target: ' + f.relationship_target_type : '',
                    f.active === false ? 'INACTIVE' : 'active',
                    f.custom_field_options ? 'options: ' + f.custom_field_options.map(function (o) { return o.value; }).join(', ') : '']
                .filter(function (x) { return x !== ''; }).join(' | ');
        });
        logChunks('TICKET FIELDS (' + fields.length + ')', lines);
        return fields;
    }

    function statsSection(tok, fields) {
        var titles = {};
        fields.forEach(function (f) { titles[f.id] = f.title; });

        var total = 0, byStatus = {}, withOrg = 0, withRequester = 0, withForm = {};
        var cf = {};          // field id -> { count, samples[] }
        var top = {};         // top-level attribute -> count
        var samples = [], fallback = [];

        var url = '/api/v2/incremental/tickets/cursor.json?start_time=0';
        for (var page = 0; url && page < MAX_PAGES; page++) {
            var d = zget(tok, url);
            if (!d) break;
            (d.tickets || []).forEach(function (t) {
                if (t.status === 'deleted') return;
                total++;
                byStatus[t.status] = (byStatus[t.status] || 0) + 1;
                if (t.organization_id) withOrg++;
                if (t.requester_id) withRequester++;
                withForm[t.ticket_form_id || 'none'] = (withForm[t.ticket_form_id || 'none'] || 0) + 1;

                ['subject', 'description', 'priority', 'type', 'assignee_id', 'group_id', 'brand_id',
                 'tags', 'external_id', 'due_at', 'via'].forEach(function (k) {
                    if (hasValue(t[k])) top[k] = (top[k] || 0) + 1;
                });

                var anyCustom = false;
                (t.custom_fields || []).forEach(function (c) {
                    if (!hasValue(c.value)) return;
                    anyCustom = true;
                    var e = cf[c.id] = cf[c.id] || { count: 0, samples: [] };
                    e.count++;
                    var sv = short(c.value);
                    if (e.samples.length < 3 && e.samples.indexOf(sv) < 0) e.samples.push(sv);
                });

                if (anyCustom && samples.length < SAMPLE_COUNT) samples.push(t);
                else if (fallback.length < SAMPLE_COUNT) fallback.push(t);
            });
            url = d.end_of_stream ? '' : d.after_url;
        }

        log.audit('TICKET STATS', {
            ticketsRead: total,
            byStatus: byStatus,
            withOrganization: withOrg,
            withoutOrganization: total - withOrg,
            withRequester: withRequester,
            byTicketFormId: withForm,
            standardFieldsFilled: top
        });

        var lines = Object.keys(cf).sort(function (a, b) { return cf[b].count - cf[a].count; }).map(function (id) {
            return id + ' | ' + (titles[id] || '(unknown field)') + ' | filled on ' + cf[id].count + ' of ' + total +
                   ' | e.g. ' + cf[id].samples.join(' ; ');
        });
        if (!lines.length) lines = ['No custom field has a value on any ticket'];
        logChunks('CUSTOM FIELDS WITH VALUES', lines);

        return samples.concat(fallback).slice(0, SAMPLE_COUNT);
    }

    function logTicket(tok, title, t) {
        var reqOrg = '';
        if (t.requester_id) {
            var u = zget(tok, '/api/v2/users/' + t.requester_id + '.json');
            if (u && u.user) reqOrg = { requester: u.user.name, email: u.user.email, requesterOrgId: u.user.organization_id };
        }
        var slim = {
            id: t.id, subject: t.subject, status: t.status, priority: t.priority, type: t.type,
            organization_id: t.organization_id, requester_id: t.requester_id, requester: reqOrg,
            ticket_form_id: t.ticket_form_id, brand_id: t.brand_id, tags: t.tags, via: t.via && t.via.channel,
            created_at: t.created_at,
            custom_fields: (t.custom_fields || []).filter(function (c) { return hasValue(c.value); }),
            description: String(t.description || '').slice(0, 300)
        };
        log.audit(title, JSON.stringify(slim, null, 1).slice(0, 3900));
    }

    // ---------------------------------------------------------------
    function getInputData() {
        var tok = token();
        var fields = fieldsSection(tok);
        var samples = statsSection(tok, fields);

        samples.forEach(function (t, i) { logTicket(tok, 'SAMPLE TICKET ' + (i + 1) + ' (#' + t.id + ')', t); });

        if (TEST_TICKET_ID) {
            var one = zget(tok, '/api/v2/tickets/' + encodeURIComponent(TEST_TICKET_ID) + '.json');
            if (one && one.ticket) logTicket(tok, 'TEST TICKET #' + TEST_TICKET_ID, one.ticket);
        }
        return [];   // nothing to process: discovery only
    }

    function map(context) { }

    function summarize(summary) {
        summary.inputSummary.error && log.error('INPUT ERROR', summary.inputSummary.error);
        log.audit('TICKET DISCOVERY DONE', { seconds: summary.seconds });
    }

    return { getInputData: getInputData, map: map, summarize: summarize };
});