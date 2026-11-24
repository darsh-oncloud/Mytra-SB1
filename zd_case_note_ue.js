/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 * @NModuleScope SameAccount
 *
 * NetSuite Case -> Zendesk ticket INTERNAL NOTE
 *
 * Deploy on: Case (Support Case). Event: After Submit.
 *
 * When the case is saved and the "Send to Zendesk" checkbox is ticked:
 *   1. Ticket ID = case External ID 'ZD-458'  ->  458
 *   2. Posts the "Zendesk Status" field text to that ticket as an INTERNAL note
 *      (public: false -> customer never sees it, no customer email)
 *   3. Unticks the checkbox (only if Zendesk accepted the note)
 *      If Zendesk fails, the box stays ticked -> fix and save again to retry.
 *
 * Needs a Zendesk token with WRITE scope.
 * No script parameters: set everything below.
 */
define(['N/https', 'N/record', 'N/search', 'N/runtime', 'N/log'],
function (https, record, search, runtime, log) {

    // =====================================================
    // CONFIG - ZENDESK
    // =====================================================
    var ZD = {
        BASE_URL: 'https://mytra.zendesk.com',
        CLIENT_ID: 'netsuite_fsm_integration',
        CLIENT_SECRET: 'PASTE_SECRET_HERE',
        SCOPE: 'read write'                 // write is required to add the note
    };

    // =====================================================
    // CONFIG - NETSUITE (your new case fields)
    // =====================================================
    var F_SEND   = 'custevent_zd_send_update';   // checkbox: "Send to Zendesk"     - CHANGE to your ID
    var F_STATUS = 'custevent_zd_status_note';   // text area: "Zendesk Status"     - CHANGE to your ID
    var EXT_PREFIX = 'ZD-';

    // =====================================================
    // HELPERS
    // =====================================================
    function parse(b) { try { return JSON.parse(b); } catch (e) { return { raw: b }; } }

    function getToken() {
        if (!ZD.CLIENT_SECRET || ZD.CLIENT_SECRET.indexOf('PASTE_') === 0) throw Error('Set ZD.CLIENT_SECRET');
        var res = https.post({
            url: ZD.BASE_URL + '/oauth/tokens',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({ grant_type: 'client_credentials', client_id: ZD.CLIENT_ID,
                                   client_secret: ZD.CLIENT_SECRET, scope: ZD.SCOPE })
        });
        var d = parse(res.body);
        if (Number(res.code) !== 200 || !d.access_token) throw Error('Zendesk OAuth failed: ' + res.code + ' ' + res.body);
        return d.access_token;
    }

    // lookupFields returns text, boolean, or [{value,text}] depending on the field
    function val(v) {
        if (Array.isArray(v)) return v.length ? v[0].value : '';
        return v == null ? '' : v;
    }

    // =====================================================
    // AFTER SUBMIT
    // =====================================================
    function afterSubmit(context) {
        var T = context.UserEventType;
        if ([T.CREATE, T.EDIT, T.XEDIT].indexOf(context.type) < 0) return;

        var caseId = context.newRecord.id;

        // Read from the saved record (inline edit only has the changed fields on newRecord)
        var f = search.lookupFields({
            type: search.Type.SUPPORT_CASE, id: caseId,
            columns: [F_SEND, F_STATUS, 'externalid', 'casenumber']
        });

        var send = f[F_SEND] === true || f[F_SEND] === 'T';
        if (!send) return;

        var note = String(val(f[F_STATUS]) || '').trim();
        var ext = String(val(f.externalid) || '');
        var caseNo = val(f.casenumber) || caseId;

        if (ext.indexOf(EXT_PREFIX) !== 0) {
            log.audit('Case ' + caseNo + ' skipped', 'External ID is not ' + EXT_PREFIX + '<ticket id>: "' + ext + '"');
            return;
        }
        if (!note) {
            log.audit('Case ' + caseNo + ' skipped', 'Zendesk Status field is empty');
            return;
        }

        var ticketId = ext.slice(EXT_PREFIX.length);
        var user = runtime.getCurrentUser().name || 'NetSuite';
        var body = 'NetSuite Case #' + caseNo + ' update (' + user + '):\n' + note;

        try {
            var res = https.put({
                url: ZD.BASE_URL + '/api/v2/tickets/' + encodeURIComponent(ticketId) + '.json',
                headers: {
                    'Content-Type': 'application/json',
                    Accept: 'application/json',
                    Authorization: 'Bearer ' + getToken()
                },
                body: JSON.stringify({ ticket: { comment: { body: body, public: false } } })
            });

            if (Number(res.code) !== 200) {
                log.error('Case ' + caseNo + ': Zendesk ticket ' + ticketId + ' NOT updated',
                          'HTTP ' + res.code + ' ' + String(res.body).slice(0, 500));
                return;   // keep the box ticked so a re-save retries
            }

            // Success -> untick (submitFields from a User Event does not re-trigger this script)
            var vals = {};
            vals[F_SEND] = false;
            record.submitFields({ type: record.Type.SUPPORT_CASE, id: caseId, values: vals,
                                  options: { ignoreMandatoryFields: true } });

            log.audit('Case ' + caseNo + ' -> Zendesk ticket ' + ticketId, 'Internal note added');
        } catch (e) {
            log.error('Case ' + caseNo + ': Zendesk ticket ' + ticketId + ' NOT updated', e.name + ': ' + e.message);
        }
    }

    return { afterSubmit: afterSubmit };
});
