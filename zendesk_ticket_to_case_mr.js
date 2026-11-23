/**
 * @NApiVersion 2.1
 * @NScriptType MapReduceScript
 * @NModuleScope SameAccount
 *
 * ZENDESK DISCOVERY (READ ONLY - changes nothing in Zendesk or NetSuite)
 *
 * Run it, then open the deployment's Execution Log. Every entry title starts with
 * the section number, so sort/filter by title:
 *   1 FIELDS     all ticket fields (id, type, AGENT-ONLY or CUSTOMER-VISIBLE, dropdown values)
 *   2 STATUSES   custom ticket statuses (agent label vs. label the customer sees)
 *   3 TRIGGERS   active triggers that EMAIL THE CUSTOMER and when they fire
 *   4 TICKET     one sample ticket: status, custom status, every custom field + value
 *   5 NETSUITE   existing ZD- cases grouped by status / case type
 * Copy the log details and paste them back to Claude.
 *
 * No script parameters: set everything below.
 */
define(['N/https', 'N/search', 'N/log'], function (https, search, log) {

    var ZD = {
        BASE_URL: 'https://mytra.zendesk.com',
        CLIENT_ID: 'netsuite_fsm_integration',
        CLIENT_SECRET: '4f1beaf8b4a16f576d75f7bc4d8e77d63ac1d07a23d6f4293036c4fe62ef5779',   // same secret as the case Map/Reduce
        SCOPE: 'read',
        ASSET_FIELD_IDS: [55275377111956, 54364777978132, 47189268307348],
        CUSTOMER_SITE_FIELD_ID: 36818231414036,
        SERVICE_ORDER_TYPE_FIELD_ID: 54049604285972
    };
    var TEST_TICKET_ID = '458';

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
        return { tok: d.access_token, scope: d.scope || '?' };
    }

    // GET with paging -> { ok, items, code, body }
    function zgetAll(tok, path, key) {
        var url = ZD.BASE_URL + path, items = [];
        for (var g = 0; url && g < 50; g++) {
            var res = https.get({ url: url, headers: { Authorization: 'Bearer ' + tok, Accept: 'application/json' } });
            var d = parse(res.body);
            if (Number(res.code) !== 200) return { ok: false, code: res.code, body: JSON.stringify(d).slice(0, 300), items: items };
            items = items.concat(key ? (d[key] || []) : [d]);
            url = key ? (d.next_page || (d.meta && d.meta.has_more && d.links && d.links.next) || '') : '';
        }
        return { ok: true, items: items };
    }

    // Execution log details max ~3999 chars -> log lines in numbered chunks
    function dump(title, lines) {
        var chunk = '', part = 1;
        function flush() {
            if (!chunk) return;
            log.audit(title + ' (part ' + part++ + ')', chunk);
            chunk = '';
        }
        lines.forEach(function (l) {
            l = String(l);
            if (chunk.length + l.length + 1 > 3800) flush();
            chunk += (chunk ? '\n' : '') + l.slice(0, 3800);
        });
        flush();
    }

    // =====================================================
    // SECTIONS
    // =====================================================
    function loadFields(tok) {
        var r = zgetAll(tok, '/api/v2/ticket_fields.json?page[size]=100', 'ticket_fields');
        if (!r.ok) throw Error('ticket_fields ' + r.code + ' ' + r.body);
        return r.items;
    }

    function secFields(tok) {
        var known = {};
        ZD.ASSET_FIELD_IDS.forEach(function (i) { known[i] = '<- used as ASSET'; });
        known[ZD.CUSTOMER_SITE_FIELD_ID] = '<- used as CUSTOMER SITE';
        known[ZD.SERVICE_ORDER_TYPE_FIELD_ID] = '<- used for CASE TYPE';

        var lines = [];
        loadFields(tok).forEach(function (f) {
            var vis = f.visible_in_portal ? 'CUSTOMER-VISIBLE' + (f.editable_in_portal ? '+EDITABLE' : '') : 'AGENT-ONLY';
            lines.push('[' + f.id + '] ' + f.title + ' | type=' + f.type + ' | ' + vis +
                       ' | active=' + f.active + (f.removable === false ? ' | system' : '') + ' ' + (known[f.id] || ''));
            if (f.visible_in_portal && f.title_in_portal) lines.push('    customer sees label: "' + f.title_in_portal + '"');
            (f.custom_field_options || f.system_field_options || []).forEach(function (o) {
                lines.push('    - ' + o.name + ' => ' + o.value);
            });
        });
        return lines;
    }

    function secStatuses(tok) {
        var r = zgetAll(tok, '/api/v2/custom_statuses.json', 'custom_statuses');
        if (!r.ok) return ['Not available (' + r.code + ') - custom statuses may be off. ' + r.body];
        return r.items.map(function (s) {
            return '[' + s.id + '] category=' + s.status_category + ' | agent="' + s.agent_label +
                   '" | CUSTOMER SEES="' + s.end_user_label + '" | active=' + s.active + ' | default=' + s['default'];
        });
    }

    function secTriggers(tok) {
        var r = zgetAll(tok, '/api/v2/triggers/active.json', 'triggers');
        if (!r.ok) return ['Cannot read triggers (' + r.code + ') - token user may not be admin. ' + r.body];
        var lines = [], n = 0;
        function cond(c) { return c.field + ' ' + c.operator + ' ' + JSON.stringify(c.value); }
        r.items.forEach(function (t) {
            var acts = (t.actions || []).filter(function (a) {
                return /notification|follower|side_conversation/.test(a.field) &&
                       /requester|ccs|cc_/.test(JSON.stringify(a.value || ''));
            });
            if (!acts.length) return;
            n++;
            lines.push('[' + t.id + '] ' + t.title);
            lines.push('   ALL: ' + ((t.conditions && t.conditions.all) || []).map(cond).join(' AND '));
            lines.push('   ANY: ' + ((t.conditions && t.conditions.any) || []).map(cond).join(' OR '));
            acts.forEach(function (a) { lines.push('   ACTION: ' + a.field + ' -> ' + JSON.stringify(a.value).slice(0, 150)); });
        });
        lines.push(n + ' of ' + r.items.length + ' active triggers notify the requester/CCs.');
        return lines;
    }

    function secTicket(tok) {
        var names = {};
        try { loadFields(tok).forEach(function (f) { names[f.id] = f.title; }); } catch (e) { /* names optional */ }
        var r = zgetAll(tok, '/api/v2/tickets/' + encodeURIComponent(TEST_TICKET_ID) + '.json', null);
        if (!r.ok) return ['ERROR ' + r.code + ' ' + r.body];
        var t = r.items[0].ticket, lines = [];
        lines.push('#' + t.id + ' status=' + t.status + ' | custom_status_id=' + t.custom_status_id +
                   ' | priority=' + t.priority + ' | type=' + t.type + ' | form=' + t.ticket_form_id +
                   ' | via=' + (t.via && t.via.channel));
        lines.push('tags: ' + (t.tags || []).join(', '));
        lines.push('custom fields with a value:');
        (t.custom_fields || []).forEach(function (c) {
            if (c.value == null || c.value === '' || (Array.isArray(c.value) && !c.value.length)) return;
            lines.push('   [' + c.id + '] ' + (names[c.id] || '?') + ' = ' + JSON.stringify(c.value));
        });
        return lines;
    }

    function secNetSuite() {
        var lines = [];
        search.create({
            type: search.Type.SUPPORT_CASE,
            filters: [['externalidstring', 'startswith', 'ZD-']],
            columns: [
                search.createColumn({ name: 'status', summary: 'GROUP' }),
                search.createColumn({ name: 'custevent_nx_case_type', summary: 'GROUP' }),
                search.createColumn({ name: 'internalid', summary: 'COUNT' })
            ]
        }).run().each(function (r) {
            var c = r.columns;
            lines.push('status=' + r.getText(c[0]) + ' (' + r.getValue(c[0]) + ') | case type=' +
                       r.getText(c[1]) + ' (' + r.getValue(c[1]) + ') | cases=' + r.getValue(c[2]));
            return true;
        });
        return lines.length ? lines : ['No ZD- cases found'];
    }

    // =====================================================
    // GET INPUT DATA: one row per section
    // =====================================================
    function getInputData() {
        var t = getToken();   // fail fast if the secret is wrong
        log.audit('0 START', 'Token OK, scope granted: ' + t.scope + ' | sample ticket: ' + TEST_TICKET_ID);
        return ['1 FIELDS', '2 STATUSES', '3 TRIGGERS', '4 TICKET', '5 NETSUITE'];
    }

    // =====================================================
    // MAP: run one section, log it
    // =====================================================
    function map(context) {
        var sec = context.value;
        try {
            var lines;
            if (sec === '5 NETSUITE') {
                lines = secNetSuite();
            } else {
                var tok = getToken().tok;
                lines = sec === '1 FIELDS'   ? secFields(tok)
                      : sec === '2 STATUSES' ? secStatuses(tok)
                      : sec === '3 TRIGGERS' ? secTriggers(tok)
                      :                        secTicket(tok);
            }
            dump(sec, lines);
            context.write({ key: 'ok', value: sec });
        } catch (e) {
            log.error(sec + ' FAILED', e.name + ': ' + e.message);
            context.write({ key: 'failed', value: sec });
        }
    }

    // =====================================================
    // SUMMARIZE
    // =====================================================
    function summarize(summary) {
        var res = { ok: [], failed: [] };
        summary.output.iterator().each(function (k, v) { (res[k] = res[k] || []).push(v); return true; });
        summary.inputSummary.error && log.error('INPUT ERROR', summary.inputSummary.error);
        summary.mapSummary.errors.iterator().each(function (k, e) { log.error('MAP ERROR ' + k, e); return true; });
        log.audit('9 DISCOVERY DONE', { ok: res.ok.sort(), failed: res.failed.sort(), seconds: summary.seconds });
    }

    return { getInputData: getInputData, map: map, summarize: summarize };
});