/**
 * @NApiVersion 2.1
 * @NScriptType MapReduceScript
 * @NModuleScope SameAccount
 *
 * ZENDESK FIELD FINDER - FINAL (READ ONLY - changes nothing in Zendesk or NetSuite)
 *
 * Goal: find an existing Zendesk ticket field that
 *   - the customer can NOT see        (agent-only)
 *   - can hold text like "In Progress" (text / textarea)
 *   - no ticket is using today         (empty on every ticket)
 *   - agents can see on the ticket     (is on a ticket form)
 * so NetSuite can write the case status into it later.
 *
 * Execution Log (sort by Title):
 *   1 BEST FIELD   the field to use, or why none fits
 *   2 USE          every field that passes all checks
 *   3 MAYBE        passes, but is not on the main form (admin must add it to the form)
 *   4 NO           every other agent-only field + the reason
 *   5 TAGS         is the 'ns_' tag prefix free (fallback: tag + internal note)
 *   9 DONE
 *
 * No script parameters: set everything below. Read scope is enough.
 */
define(['N/https', 'N/log'], function (https, log) {

    // =====================================================
    // CONFIG
    // =====================================================
    var ZD = {
        BASE_URL: 'https://mytra.zendesk.com',
        CLIENT_ID: 'netsuite_fsm_integration',
        CLIENT_SECRET: '4f1beaf8b4a16f576d75f7bc4d8e77d63ac1d07a23d6f4293036c4fe62ef5779',
        SCOPE: 'read'
    };
    var MAIN_FORM_ID = 53680117029652;   // form used by FSM tickets (ticket 458)
    var NS_TAG_PREFIX = 'ns_';

    // Fields Zendesk itself fills in (AI summaries, employee service, etc.) - never reuse
    var ZENDESK_MANAGED = /^(summary|multi-recipient email id|resolution type|resolution tier|channel group|required tasks|approval status)/i;
    var TEXT_TYPES = { text: 1, textarea: 1 };

    // =====================================================
    // HELPERS
    // =====================================================
    function parse(b) { try { return JSON.parse(b); } catch (e) { return { raw: String(b).slice(0, 500) }; } }

    function getToken() {
        if (!ZD.CLIENT_SECRET || ZD.CLIENT_SECRET.indexOf('PASTE_') === 0) throw Error('Set ZD.CLIENT_SECRET');
        var res = https.post({
            url: ZD.BASE_URL + '/oauth/tokens',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({ grant_type: 'client_credentials', client_id: ZD.CLIENT_ID,
                                   client_secret: ZD.CLIENT_SECRET, scope: ZD.SCOPE })
        });
        var d = parse(res.body);
        if (Number(res.code) !== 200 || !d.access_token) throw Error('OAuth failed: ' + res.code + ' ' + res.body);
        return d.access_token;
    }

    function zget(tok, urlOrPath) {
        var url = urlOrPath.indexOf('http') === 0 ? urlOrPath : ZD.BASE_URL + urlOrPath;
        var res = https.get({ url: url, headers: { Authorization: 'Bearer ' + tok, Accept: 'application/json' } });
        if (Number(res.code) !== 200) throw Error('GET ' + urlOrPath + ' HTTP ' + res.code + ' ' + String(res.body).slice(0, 300));
        return parse(res.body);
    }

    function dump(title, lines) {
        var chunk = '', part = 1;
        function flush() { if (chunk) { log.audit(title + ' (part ' + part++ + ')', chunk); chunk = ''; } }
        lines.forEach(function (l) {
            l = String(l);
            if (chunk.length + l.length + 1 > 3800) flush();
            chunk += (chunk ? '\n' : '') + l.slice(0, 3800);
        });
        flush();
    }

    function empty(v) { return v == null || v === '' || v === false || (Array.isArray(v) && !v.length); }

    // =====================================================
    // GET INPUT DATA: does all the work, nothing to map
    // =====================================================
    function getInputData() {
        var tok = getToken();

        // 1. Agent-only, non-system fields
        var fields = {}, url = '/api/v2/ticket_fields.json?page[size]=100', d, g;
        for (g = 0; url && g < 20; g++) {
            d = zget(tok, url);
            (d.ticket_fields || []).forEach(function (f) {
                if (f.visible_in_portal || f.removable === false) return;
                fields[f.id] = { id: f.id, title: f.title, type: f.type, active: f.active,
                                 used: 0, last: '', samples: [], forms: [] };
            });
            url = d.meta && d.meta.has_more ? d.links.next : '';
        }

        // 2. Which ticket forms show each field
        var formNames = {};
        try {
            d = zget(tok, '/api/v2/ticket_forms.json');
            (d.ticket_forms || []).forEach(function (fm) {
                if (!fm.active) return;
                formNames[fm.id] = fm.name;
                (fm.ticket_field_ids || []).forEach(function (fid) {
                    if (fields[fid]) fields[fid].forms.push(fm.id);
                });
            });
        } catch (e) { log.error('Could not read ticket forms', e.message); }

        // 3. Scan every ticket for values + tags
        var total = 0, tags = {};
        url = '/api/v2/incremental/tickets/cursor.json?start_time=0';
        for (g = 0; url && g < 500; g++) {
            d = zget(tok, url);
            (d.tickets || []).forEach(function (t) {
                if (t.status === 'deleted') return;
                total++;
                (t.tags || []).forEach(function (x) { tags[x] = (tags[x] || 0) + 1; });
                (t.custom_fields || []).forEach(function (c) {
                    var f = fields[c.id];
                    if (!f || empty(c.value)) return;
                    f.used++;
                    if (t.updated_at > f.last) f.last = t.updated_at;
                    if (f.samples.length < 3) f.samples.push('#' + t.id + '=' + JSON.stringify(c.value).slice(0, 50));
                });
            });
            url = d.end_of_stream ? '' : d.after_url;
        }

        // 4. Verdict per field
        var use = [], maybe = [], no = [];
        Object.keys(fields).forEach(function (id) {
            var f = fields[id];
            var onMain = f.forms.indexOf(MAIN_FORM_ID) >= 0;
            var formTxt = f.forms.length ? f.forms.map(function (x) { return formNames[x] || x; }).join(', ') : 'NO FORM';
            var line = '[' + f.id + '] ' + f.title + ' | type=' + f.type + ' | forms: ' + formTxt;

            var why = '';
            if (!f.active) why = 'inactive';
            else if (ZENDESK_MANAGED.test(f.title)) why = 'Zendesk fills this itself';
            else if (!TEXT_TYPES[f.type]) why = 'type ' + f.type + ' cannot hold free text';
            else if (f.used) why = 'IN USE on ' + f.used + '/' + total + ' tickets, last ' + f.last.slice(0, 10) +
                                   ' e.g. ' + f.samples.join(' ');

            if (why) no.push(line + '  -> NO: ' + why);
            else if (onMain) use.push(line + '  -> USE: agent-only, text, empty on all ' + total + ' tickets, on main form');
            else maybe.push(line + '  -> MAYBE: empty and agent-only, but NOT on main form ' + MAIN_FORM_ID +
                            ' (admin adds it to the form - no new field needed)');
        });

        // 5. Report
        var best;
        if (use.length) best = 'USE THIS FIELD: ' + use[0];
        else if (maybe.length) best = 'NO field is ready. Best option after admin adds it to the form: ' + maybe[0];
        else best = 'NO usable field. Fallback (no field needed): internal note + "' + NS_TAG_PREFIX + '" status tag.';
        dump('1 BEST FIELD', ['Tickets scanned: ' + total + ' | agent-only fields checked: ' + Object.keys(fields).length, best]);
        dump('2 USE', use.length ? use : ['none']);
        dump('3 MAYBE', maybe.length ? maybe : ['none']);
        dump('4 NO', no.length ? no : ['none']);

        var nsTags = Object.keys(tags).filter(function (x) { return x.indexOf(NS_TAG_PREFIX) === 0; });
        dump('5 TAGS', [
            'Tags starting with "' + NS_TAG_PREFIX + '": ' + (nsTags.join(', ') || 'none - prefix is free to use'),
            'Distinct tags in Zendesk: ' + Object.keys(tags).length
        ]);
        return [];
    }

    function map(context) { }

    function summarize(summary) {
        summary.inputSummary.error && log.error('INPUT ERROR', summary.inputSummary.error);
        log.audit('9 DONE', { seconds: summary.seconds });
    }

    return { getInputData: getInputData, map: map, summarize: summarize };
});