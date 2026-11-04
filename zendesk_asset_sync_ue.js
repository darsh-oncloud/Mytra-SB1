/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 * @NModuleScope SameAccount
 *
 * Field Service Asset -> Zendesk (CREATE ONLY)
 *
 * Flow (afterSubmit, CREATE):
 *  1. Read Field Service Asset fields (lookupFields, low governance)
 *  2. Read linked Customer -> Zendesk Organization ID
 *       - populated : use it
 *       - empty     : create Organization in Zendesk, save ID on Customer
 *  3. Match NetSuite Asset Status text to Zendesk status (by name)
 *  4. Create Zendesk Asset under that Organization
 *  5. Save Zendesk Asset ID back on the Field Service Asset
 *
 * Deploy on: Field Service Asset custom record, Event Type = Create
 */
define(['N/https', 'N/record', 'N/search', 'N/runtime', 'N/format', 'N/log'],
function (https, record, search, runtime, format, log) {

    // =====================================================
    // 1. ZENDESK CONFIG
    // =====================================================
    var ZD = {
        BASE_URL: 'https://mytra.zendesk.com',
        CLIENT_ID: 'netsuite_fsm_integration',
        // Preferred: store the secret in a script parameter (Password type)
        SECRET_PARAM: 'custscript_zd_client_secret',
        CLIENT_SECRET_FALLBACK: 'PASTE_ROTATED_SECRET_HERE',
        SCOPE: 'read write',

        // Confirmed from your logs: "Bot" asset type
        ASSET_TYPE_ID: '01M66KSY9W5XGPN4BJVST123JK',

        // Used only when the NetSuite Asset Status is blank ("Available")
        DEFAULT_STATUS_ID: '01KKM6AZ63CRKT2TPZJSHJ5E7W',

        DEFAULT_MANUFACTURER: 'Mytra',

        // Zendesk custom field key for Asset Contract Status.
        // Keys seen in your logs: asset_tag___barcode_id, deployment_status,
        // tool_name, kit___toolbag. Put the right key here once created;
        // leave '' to skip sending it.
        CONTRACT_STATUS_KEY: ''
    };

    // =====================================================
    // 2. NETSUITE FIELD IDS  (update these)
    // =====================================================
    var CUST = {
        zdOrgId: 'custentity_zendesk_org_id'          // create this field
    };

    var ASSET = {
        zdAssetId:      'custrecord_zendesk_asset_id', // create this field
        name:           'name',
        customer:       'custrecord_nx_asset_customer', // verify
        item:           'custrecord_nx_asset_item',     // verify
        serial:         'custrecord_nx_asset_serial',   // verify
        status:         'REPLACE_ASSET_STATUS_FIELD_ID',
        contractStatus: 'REPLACE_CONTRACT_STATUS_FIELD_ID',
        warrantyEnd:    'REPLACE_WARRANTY_END_FIELD_ID'
    };

    // =====================================================
    // HELPERS
    // =====================================================
    function isSet(fieldId) {
        return !!fieldId && fieldId.indexOf('REPLACE_') !== 0;
    }

    function parse(body) {
        try { return JSON.parse(body); } catch (e) { return { raw: body }; }
    }

    function norm(v) {
        return String(v || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
    }

    // lookupFields returns select fields as [{value, text}]
    function val(r, f) {
        if (!isSet(f)) return '';
        var v = r[f];
        if (Array.isArray(v)) return v.length ? v[0].value : '';
        return v == null ? '' : v;
    }

    function txt(r, f) {
        if (!isSet(f)) return '';
        var v = r[f];
        if (Array.isArray(v)) return v.length ? v[0].text : '';
        return v == null ? '' : String(v);
    }

    function toIsoDate(nsDate) {
        if (!nsDate) return '';
        try {
            var d = format.parse({ value: nsDate, type: format.Type.DATE });
            var mm = ('0' + (d.getMonth() + 1)).slice(-2);
            var dd = ('0' + d.getDate()).slice(-2);
            return d.getFullYear() + '-' + mm + '-' + dd;
        } catch (e) {
            log.audit('Warranty date not parsed', nsDate);
            return '';
        }
    }

    function api(token, method, endpoint, payload) {
        var opts = {
            url: ZD.BASE_URL + endpoint,
            headers: {
                Authorization: 'Bearer ' + token,
                Accept: 'application/json',
                'Content-Type': 'application/json'
            }
        };
        if (payload) opts.body = JSON.stringify(payload);

        var res = method === 'POST' ? https.post(opts) : https.get(opts);
        var out = { code: Number(res.code), data: parse(res.body) };

        if (out.code < 200 || out.code >= 300) {
            log.error('Zendesk ' + method + ' ' + endpoint, {
                httpCode: out.code, request: payload || null, response: out.data
            });
        }
        return out;
    }

    // =====================================================
    // OAUTH
    // =====================================================
    function getToken() {
        var secret = runtime.getCurrentScript()
            .getParameter({ name: ZD.SECRET_PARAM }) || ZD.CLIENT_SECRET_FALLBACK;

        var res = https.post({
            url: ZD.BASE_URL + '/oauth/tokens',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({
                grant_type: 'client_credentials',
                client_id: ZD.CLIENT_ID,
                client_secret: secret,
                scope: ZD.SCOPE
            })
        });

        var data = parse(res.body);
        if (Number(res.code) !== 200 || !data.access_token) {
            throw Error('Zendesk OAuth failed: ' + res.code + ' ' + JSON.stringify(data));
        }
        return data.access_token;
    }

    // =====================================================
    // ORGANIZATION: use existing ID or create
    // =====================================================
    function getOrCreateOrg(token, customerId) {
        var c = search.lookupFields({
            type: search.Type.CUSTOMER,
            id: customerId,
            columns: ['companyname', 'entityid', CUST.zdOrgId]
        });

        var existing = val(c, CUST.zdOrgId);
        if (existing) {
            log.audit('Organization found on Customer', existing);
            return String(existing);
        }

        var orgName = c.companyname || c.entityid;
        if (!orgName) throw Error('Customer ' + customerId + ' has no name');

        // create_or_update matches on external_id, so a retry won't duplicate
        var res = api(token, 'POST', '/api/v2/organizations/create_or_update.json', {
            organization: {
                name: String(orgName),
                external_id: 'NS-CUST-' + customerId
            }
        });

        var orgId = res.data.organization && res.data.organization.id;

        // 422 = name already taken in Zendesk -> reuse that organization
        if (!orgId && res.code === 422) {
            var found = api(token, 'GET',
                '/api/v2/organizations/search.json?name=' + encodeURIComponent(orgName));
            var orgs = (found.data && found.data.organizations) || [];
            if (orgs.length === 1) orgId = orgs[0].id;
        }

        if (!orgId) throw Error('Could not create/find Zendesk Organization for ' + orgName);

        var values = {};
        values[CUST.zdOrgId] = String(orgId);
        record.submitFields({
            type: record.Type.CUSTOMER,
            id: customerId,
            values: values,
            options: { enableSourcing: false, ignoreMandatoryFields: true }
        });

        log.audit('Organization created & saved', { customerId: customerId, zendeskOrgId: orgId });
        return String(orgId);
    }

    // =====================================================
    // STATUS: NetSuite list text -> Zendesk status ID
    // (matches Zendesk name or external_id, e.g. "In use" / "in_use")
    // =====================================================
    function getStatusId(token, nsStatusText) {
        if (!nsStatusText) return ZD.DEFAULT_STATUS_ID;

        var res = api(token, 'GET', '/api/v2/it_asset_management/statuses');
        if (res.code !== 200) throw Error('Could not read Zendesk statuses');

        var key = norm(nsStatusText);
        var list = res.data.statuses || [];

        for (var i = 0; i < list.length; i++) {
            if (norm(list[i].name) === key || norm(list[i].external_id) === key) {
                return String(list[i].id);
            }
        }

        throw Error('No Zendesk status matches NetSuite status "' + nsStatusText +
            '". Available: ' + list.map(function (s) { return s.name; }).join(', '));
    }

    // =====================================================
    // AFTER SUBMIT
    // =====================================================
    function afterSubmit(context) {
        if (context.type !== context.UserEventType.CREATE) return;

        var assetId = context.newRecord.id;
        var assetType = context.newRecord.type;

        try {
            // ---------- read asset (1 lookup) ----------
            var cols = [];
            Object.keys(ASSET).forEach(function (k) {
                if (isSet(ASSET[k])) cols.push(ASSET[k]);
            });

            var a = search.lookupFields({ type: assetType, id: assetId, columns: cols });

            if (val(a, ASSET.zdAssetId)) {
                log.audit('Skipped: Zendesk Asset ID already set', val(a, ASSET.zdAssetId));
                return;
            }

            var d = {
                name:           txt(a, ASSET.name),
                customerId:     val(a, ASSET.customer),
                model:          txt(a, ASSET.item),
                serial:         txt(a, ASSET.serial),
                status:         txt(a, ASSET.status),
                contractStatus: txt(a, ASSET.contractStatus),
                warrantyEnd:    toIsoDate(txt(a, ASSET.warrantyEnd))
            };

            log.audit('NetSuite Asset ' + assetId, d);

            if (!d.name || !d.customerId) {
                throw Error('Asset Name or Customer is missing');
            }

            // ---------- Zendesk ----------
            var token = getToken();
            var orgId = getOrCreateOrg(token, d.customerId);
            var statusId = getStatusId(token, d.status);

            var asset = {
                name: d.name,
                external_id: 'NS-ASSET-' + assetId,
                asset_type_id: ZD.ASSET_TYPE_ID,
                status_id: statusId,
                organization_id: Number(orgId),
                manufacturer: ZD.DEFAULT_MANUFACTURER
            };
            if (d.serial) asset.serial_number = d.serial;
            if (d.model) asset.model = d.model;
            if (d.warrantyEnd) asset.warranty_expiration = d.warrantyEnd;
            if (ZD.CONTRACT_STATUS_KEY && d.contractStatus) {
                asset.custom_field_values = {};
                asset.custom_field_values[ZD.CONTRACT_STATUS_KEY] = d.contractStatus;
            }

            log.audit('Zendesk Asset Payload', asset);

            var res = api(token, 'POST', '/api/v2/it_asset_management/assets', { asset: asset });

            if (res.code !== 201 || !res.data.asset || !res.data.asset.id) {
                throw Error('Zendesk Asset creation failed: HTTP ' + res.code);
            }

            // ---------- save ID back ----------
            var values = {};
            values[ASSET.zdAssetId] = String(res.data.asset.id);
            record.submitFields({
                type: assetType,
                id: assetId,
                values: values,
                options: { enableSourcing: false, ignoreMandatoryFields: true }
            });

            log.audit('ZENDESK SYNC SUCCESS', {
                netsuiteAssetId: assetId,
                zendeskAssetId: res.data.asset.id,
                zendeskOrgId: orgId,
                zendeskStatusId: statusId,
                remainingUsage: runtime.getCurrentScript().getRemainingUsage()
            });

        } catch (e) {
            log.error('ZENDESK SYNC FAILED', {
                netsuiteAssetId: assetId,
                message: e.message,
                stack: e.stack
            });
        }
    }

    return { afterSubmit: afterSubmit };
});
