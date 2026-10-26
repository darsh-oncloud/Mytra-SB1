/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 * @NModuleScope SameAccount
 *
 * Script Name: UE Create FSM Asset and Task on Transfer Order
 * Description: Automatically creates a Field Service Asset and Task upon Transfer Order creation/edit
 *              if the line item has 'custcol_fsm_task_type' (or 'custcol_mynt_fsm_task_type') populated.
 *              Sourcing:
 *              - Customer from custom field 'custbody_customer' (with fallback to 'custbody_end_customer' / 'entity').
 *              - Delivery address from 'shipaddress' or customer record.
 *              - TO Field mappings to Asset:
 *                  custbody_asset_status           => custrecord_asset_status
 *                  custbody_asset_lease_start_date => custrecord_lease_start_date
 *                  custbody_asset_lease_end_date   => custrecord_lease_end_date
 *                  custbody_asset_under_warranty   => custrecord_under_warranty
 *                  custbody_asset_warranty_start_date => custrecord_warranty_start_date
 *                  custbody_asset_warranty_end_date   => custrecord_warranty_end_date
 *              - Links task to Transfer Order via 'transaction' and 'custevent_nx_created_from'.
 *              - Task Form ID retrieved dynamically from script parameter 'custscript_task_form_id'.
 *              - Includes duplicate check on EDIT to avoid recreating tasks for existing lines.
 */
define(['N/record', 'N/log', 'N/search', 'N/runtime'], (record, log, search, runtime) => {

    /**
     * Constants & Configuration Mapping
     */
    const CONFIG = {
        DEFAULT_TASK_FORM_ID: 418,
        ASSET_RECORD_TYPE: 'customrecord_nx_asset', // Field Service Asset record type
        FIELDS: {
            // Line Item Fields on Transfer Order
            TASK_TYPE_COL: 'custcol_fsm_task_type',
            TASK_TYPE_COL_ALT: 'custcol_mynt_fsm_task_type',
            
            // Transfer Order Header Fields
            TO_CUSTOMER: 'custbody_customer',
            TO_CUSTOMER_ALT: 'custbody_end_customer',
            TO_CUSTOMER_ENTITY: 'entity',
            TO_SHIP_ADDRESS: 'shipaddress',
            TO_FROM_LOCATION: 'location',
            TO_DEST_LOCATION: 'transferlocation',
            
            // Asset Fields
            ASSET_SERIAL: 'custrecord_nx_asset_serial',
            ASSET_ITEM: 'custrecord_nx_asset_item',
            ASSET_NAME: 'name',
            ASSET_TRANSACTION: 'custrecord_nx_asset_transaction', // Link to Transfer Order
            ASSET_CUSTOMER: 'custrecord_nx_asset_customer',       // Customer link on Asset
            
            // Task Fields
            TASK_COMPANY: 'company',                // Standard NetSuite Customer/Entity field (FSM Mobile Customer Header)
            TASK_CUSTOMER: 'custevent_nx_customer', // FSM Custom Customer link on Task
            TASK_ADDRESS: 'custevent_nx_address',   // FSM Custom Address on Task
            TASK_TRANSACTION: 'transaction',        // Standard transaction link
            TASK_CREATED_FROM: 'custevent_nx_created_from', // NextService source link on Task
            TASK_ASSET: 'custevent_nx_task_asset',  // Custom asset link field on Task
            TASK_TYPE: 'custevent_nx_task_type',    // Custom task type field on Task
            TASK_TITLE: 'title',
            TASK_ASSIGNED: 'assigned',
            TASK_STATUS: 'status',
            TASK_MESSAGE: 'message'                 // Description/Notes visible on FSM Mobile
        }
    };

    /**
     * Function executed after a record is submitted.
     * @param {Object} scriptContext
     * @param {Record} scriptContext.newRecord - New record
     * @param {string} scriptContext.type - Trigger type
     */
    const afterSubmit = (scriptContext) => {
        // Process on CREATE or EDIT (for testing and incremental line additions)
        if (scriptContext.type !== scriptContext.UserEventType.CREATE && 
            scriptContext.type !== scriptContext.UserEventType.EDIT) {
            return;
        }

        const newRecord = scriptContext.newRecord;
        const toId = newRecord.id;
        
        let tranId = newRecord.getValue({ fieldId: 'tranid' });
        if (!tranId || tranId === 'To Be Generated') {
            try {
                const toLookup = search.lookupFields({
                    type: search.Type.TRANSFER_ORDER,
                    id: toId,
                    columns: ['tranid']
                });
                if (toLookup && toLookup.tranid && toLookup.tranid !== 'To Be Generated') {
                    tranId = toLookup.tranid;
                }
            } catch (e) {
                log.debug('Lookup tranid fallback', e.message);
            }
        }
        if (!tranId || tranId === 'To Be Generated') {
            tranId = 'TO #' + toId;
        }
        const tranDate = newRecord.getText({ fieldId: 'trandate' }) || '';

        // Sourcing Customer & Address Info from Transfer Order (primarily 'custbody_customer')
        const customerInfo = resolveCustomerFromTO(newRecord);

        // Sourcing Employee Info (Assigned Delivery Employee / Technician)
        const deliveryEmployee = newRecord.getValue({ fieldId: 'custbody_delivery_employee' });
        const toEmployee = newRecord.getValue({ fieldId: 'employee' });

        let employeeId = deliveryEmployee;
        if (!employeeId && toEmployee && !isAdminEmployee(toEmployee)) {
            employeeId = toEmployee;
        }

        const employeeText = newRecord.getText({ fieldId: 'custbody_delivery_employee' }) ||
                             (employeeId ? newRecord.getText({ fieldId: 'employee' }) : 'Unassigned');

        // Sourcing Location Info (From Location: Warehouse, To Location: Destination / Customer Generic)
        const fromLocationText = newRecord.getText({ fieldId: CONFIG.FIELDS.TO_FROM_LOCATION }) || 'Main Warehouse';
        const toLocationText = newRecord.getText({ fieldId: CONFIG.FIELDS.TO_DEST_LOCATION }) || 'Customer Site / Staging';

        // Sourcing Custom Fields from TO mapped to Asset
        const assetCustomFields = {
            custrecord_asset_status: newRecord.getValue({ fieldId: 'custbody_asset_status' }),
            custrecord_lease_start_date: newRecord.getValue({ fieldId: 'custbody_asset_lease_start_date' }),
            custrecord_lease_end_date: newRecord.getValue({ fieldId: 'custbody_asset_lease_end_date' }),
            custrecord_under_warranty: newRecord.getValue({ fieldId: 'custbody_asset_under_warranty' }),
            custrecord_warranty_start_date: newRecord.getValue({ fieldId: 'custbody_asset_warranty_start_date' }),
            custrecord_warranty_end_date: newRecord.getValue({ fieldId: 'custbody_asset_warranty_end_date' })
        };

        // Text versions for Mobile Notes
        const assetStatusText = newRecord.getText({ fieldId: 'custbody_asset_status' }) || '';
        const leaseStartText = newRecord.getText({ fieldId: 'custbody_asset_lease_start_date' }) || '';
        const leaseEndText = newRecord.getText({ fieldId: 'custbody_asset_lease_end_date' }) || '';
        const underWarranty = newRecord.getValue({ fieldId: 'custbody_asset_under_warranty' });
        const warrantyStartText = newRecord.getText({ fieldId: 'custbody_asset_warranty_start_date' }) || '';
        const warrantyEndText = newRecord.getText({ fieldId: 'custbody_asset_warranty_end_date' }) || '';

        // Sourcing Task Form ID from Script Parameter 'custscript_task_form_id'
        const scriptObj = runtime.getCurrentScript();
        const paramFormId = scriptObj.getParameter({ name: 'custscript_task_form_id' });
        const taskFormId = paramFormId ? parseInt(paramFormId, 10) : CONFIG.DEFAULT_TASK_FORM_ID;

        log.audit('afterSubmit Init', `Processing Transfer Order ID: ${toId} (${tranId}) | Customer: ${customerInfo.name} (ID: ${customerInfo.id}) | Assignee: ${employeeText} (ID: ${employeeId}) | Form: ${taskFormId}`);

        try {
            const lineCount = newRecord.getLineCount({ sublistId: 'item' });
            if (lineCount === 0) {
                log.debug('No Lines', 'Transfer Order has no item lines.');
                return;
            }

            // On EDIT, query existing tasks for this TO to avoid duplicate task creation
            const existingTasks = (scriptContext.type === scriptContext.UserEventType.EDIT)
                ? getExistingTasksForTransferOrder(toId)
                : [];

            for (let i = 0; i < lineCount; i++) {
                // Main Condition Check: Line must have 'custcol_fsm_task_type' or 'custcol_mynt_fsm_task_type' populated
                const taskType = newRecord.getSublistValue({
                    sublistId: 'item',
                    fieldId: CONFIG.FIELDS.TASK_TYPE_COL,
                    line: i
                }) || newRecord.getSublistValue({
                    sublistId: 'item',
                    fieldId: CONFIG.FIELDS.TASK_TYPE_COL_ALT,
                    line: i
                });

                if (!taskType) {
                    log.debug('Skip Line', `Line ${i + 1}: Task Type is empty. Skipping.`);
                    continue;
                }

                const itemId = newRecord.getSublistValue({
                    sublistId: 'item',
                    fieldId: 'item',
                    line: i
                });

                const itemText = newRecord.getSublistText({
                    sublistId: 'item',
                    fieldId: 'item',
                    line: i
                }) || ('Item_' + itemId);

                const quantity = newRecord.getSublistValue({
                    sublistId: 'item',
                    fieldId: 'quantity',
                    line: i
                }) || 1;

                const units = newRecord.getSublistText({
                    sublistId: 'item',
                    fieldId: 'units',
                    line: i
                }) || '';

                const lineDescription = newRecord.getSublistValue({
                    sublistId: 'item',
                    fieldId: 'description',
                    line: i
                }) || '';

                const lineLocationText = newRecord.getSublistText({
                    sublistId: 'item',
                    fieldId: 'location',
                    line: i
                }) || fromLocationText;

                // Extract Serial Number from Inventory Detail / Line / Generated serial
                const serialNumber = getSerialNumberFromLine(newRecord, i) || (`Robot_TO${toId}_L${i + 1}`);

                // Check for duplicate task on EDIT
                const alreadyExists = existingTasks.some((task) => {
                    return task.title.includes(serialNumber) || (task.itemText === itemText && task.lineIndex === (i + 1));
                });

                if (alreadyExists) {
                    log.debug('Duplicate Skipped', `Line ${i + 1}: Task already exists for Serial '${serialNumber}' on TO #${tranId}.`);
                    continue;
                }

                log.audit('Trigger Met', `Line ${i + 1}: Task Type '${taskType}' found for Item '${itemText}' (Qty: ${quantity}, Serial: ${serialNumber}). Creating Asset & Task...`);

                // Step 1: Create Field Service Asset Record linked to Customer, Transfer Order, and TO custom fields
                const assetId = createFieldServiceAsset({
                    itemId: itemId,
                    itemText: itemText,
                    serialNumber: serialNumber,
                    toId: toId,
                    customerId: customerInfo.id,
                    assetCustomFields: assetCustomFields
                });

                // Concise preview title for FSM mobile card
                const displayTo = tranId && tranId.toString().startsWith('TO') ? tranId : ('TO #' + tranId);
                const taskPreviewSummary = `Pick & Deliver: ${itemText} (${serialNumber}) - ${displayTo}`;

                // Multi-line breakdown for FSM Mobile tabs
                const taskFullDescription = [
                    `--- TRANSFER ORDER & DELIVERY DETAILS ---`,
                    `• Transfer Order #: ${tranId}`,
                    `• Date: ${tranDate}`,
                    `• Customer: ${customerInfo.name || 'Not Specified'}`,
                    `• Delivery Address: ${customerInfo.address ? customerInfo.address.replace(/\r?\n/g, ', ') : 'Not Specified'}`,
                    `• Source Location: ${lineLocationText}`,
                    `• Destination Location: ${toLocationText}`,
                    `• Assigned Employee / Driver: ${employeeText}`,
                    ``,
                    `--- ITEM & ROBOT PICK DETAILS ---`,
                    `• Item: ${itemText}`,
                    `• Description: ${lineDescription || 'N/A'}`,
                    `• Quantity: ${quantity} ${units}`.trim(),
                    `• Robot / Serial #: ${serialNumber}`,
                    ``,
                    `--- ASSET & WARRANTY DETAILS ---`,
                    `• Asset Status: ${assetStatusText || 'N/A'}`,
                    `• Under Warranty: ${underWarranty ? 'Yes' : 'No'}`,
                    `• Warranty Period: ${warrantyStartText || 'N/A'} to ${warrantyEndText || 'N/A'}`,
                    `• Lease Period: ${leaseStartText || 'N/A'} to ${leaseEndText || 'N/A'}`,
                    ``,
                    `--- WORKFLOW INSTRUCTIONS ---`,
                    `1. Robot Pick: Pick skid/item (${itemText}) in ${lineLocationText} warehouse and stage for transport.`,
                    `2. Transport & Delivery: Deliver to customer site: ${customerInfo.name || 'Customer Site'} (${toLocationText}).`,
                    `3. Mark Complete: Complete the task upon successful delivery and setup.`
                ].join('\n');

                // Step 2: Create Task Record with Customer, Address, Transfer Order Link, and Tab Fields
                const taskId = createFSMTask({
                    formId: taskFormId,
                    toId: toId,
                    tranId: tranId,
                    tranDate: tranDate,
                    assetId: assetId,
                    taskType: taskType,
                    itemText: itemText,
                    itemDesc: lineDescription,
                    serialNumber: serialNumber,
                    quantity: quantity,
                    units: units,
                    employeeId: employeeId,
                    employeeText: employeeText,
                    customerId: customerInfo.id,
                    customerText: customerInfo.name,
                    customerAddress: customerInfo.address,
                    fromLocation: lineLocationText,
                    title: taskPreviewSummary,
                    fullDescription: taskFullDescription,
                    lineIndex: i + 1
                });

                log.audit('FSM Records Created Successfully', `Line ${i + 1}: Created Asset ID #${assetId} & Task ID #${taskId} (Form ${taskFormId}) for TO ${tranId}`);
            }

        } catch (error) {
            log.error('Error in UE Create FSM Asset and Task on Transfer Order', error);
        }
    };

    /**
     * Queries existing tasks linked to this Transfer Order to avoid duplicate creation on EDIT.
     */
    const getExistingTasksForTransferOrder = (toId) => {
        const existing = [];
        try {
            const taskSearch = search.create({
                type: search.Type.TASK,
                filters: [
                    ['transaction', 'anyof', toId]
                ],
                columns: [
                    search.createColumn({ name: 'internalid' }),
                    search.createColumn({ name: 'title' }),
                    search.createColumn({ name: 'custevent_nx_task_asset' })
                ]
            });
            taskSearch.run().each((res) => {
                existing.push({
                    id: res.getValue({ name: 'internalid' }),
                    title: res.getValue({ name: 'title' }) || '',
                    assetId: res.getValue({ name: 'custevent_nx_task_asset' })
                });
                return true;
            });
        } catch (e) {
            log.debug('Check Existing Tasks Error', e.message);
        }
        return existing;
    };

    /**
     * Checks if an employee has Administrator role in NetSuite.
     * Prevents security permission conflicts on mobile when technician edits tasks assigned to Admins.
     */
    const isAdminEmployee = (empId) => {
        if (!empId) return false;
        try {
            const empLookup = search.lookupFields({
                type: search.Type.EMPLOYEE,
                id: empId,
                columns: ['role']
            });
            if (empLookup && empLookup.role) {
                const roles = Array.isArray(empLookup.role) ? empLookup.role : [empLookup.role];
                return roles.some((r) => r.value === '3' || (r.text && r.text.toLowerCase().includes('administrator')));
            }
        } catch (e) {
            log.debug('Check Admin Employee Info', e.message);
        }
        return false;
    };

    /**
     * Sourcing Customer & Address from Transfer Order using 'custbody_customer'.
     */
    const resolveCustomerFromTO = (toRecord) => {
        let customerId = toRecord.getValue({ fieldId: CONFIG.FIELDS.TO_CUSTOMER }) ||
                         toRecord.getValue({ fieldId: CONFIG.FIELDS.TO_CUSTOMER_ALT }) ||
                         toRecord.getValue({ fieldId: CONFIG.FIELDS.TO_CUSTOMER_ENTITY });
        
        let customerName = toRecord.getText({ fieldId: CONFIG.FIELDS.TO_CUSTOMER }) ||
                           toRecord.getText({ fieldId: CONFIG.FIELDS.TO_CUSTOMER_ALT }) ||
                           toRecord.getText({ fieldId: CONFIG.FIELDS.TO_CUSTOMER_ENTITY }) || '';

        // Sourcing Shipping Address from Transfer Order header
        let customerAddress = toRecord.getValue({ fieldId: CONFIG.FIELDS.TO_SHIP_ADDRESS }) || '';

        // Fallback: Query Customer record directly if TO shipaddress is empty
        if (!customerAddress && customerId) {
            customerAddress = getCustomerAddress(customerId);
        }

        return {
            id: customerId || null,
            name: customerName,
            address: customerAddress
        };
    };

    /**
     * Retrieves the formatted address for a customer as fallback.
     */
    const getCustomerAddress = (customerId) => {
        if (!customerId) return '';
        try {
            let formattedAddress = '';
            const custSearch = search.create({
                type: search.Type.CUSTOMER,
                filters: [['internalid', 'anyof', customerId]],
                columns: [
                    search.createColumn({ name: 'shipaddress' }),
                    search.createColumn({ name: 'defaultaddress' }),
                    search.createColumn({ name: 'address' })
                ]
            });

            custSearch.run().each((result) => {
                formattedAddress = result.getValue({ name: 'shipaddress' }) ||
                                   result.getValue({ name: 'defaultaddress' }) ||
                                   result.getValue({ name: 'address' }) || '';
                return false;
            });

            if (formattedAddress) {
                return formattedAddress;
            }

            const lookup = search.lookupFields({
                type: search.Type.CUSTOMER,
                id: customerId,
                columns: ['defaultaddress']
            });
            if (lookup && lookup.defaultaddress) {
                return lookup.defaultaddress;
            }
        } catch (e) {
            log.debug('Customer Address Search Error', e.message);
        }
        return '';
    };

    /**
     * Extracts serial number from item line or inventory detail subrecord.
     */
    const getSerialNumberFromLine = (toRecord, lineIndex) => {
        try {
            let serial = toRecord.getSublistValue({
                sublistId: 'item',
                fieldId: 'serialnumbers',
                line: lineIndex
            }) || toRecord.getSublistValue({
                sublistId: 'item',
                fieldId: 'custcol_serial_number',
                line: lineIndex
            });

            if (serial) return serial;

            const invDetail = toRecord.getSublistSubrecord({
                sublistId: 'item',
                fieldId: 'inventorydetail',
                line: lineIndex
            });

            if (invDetail && invDetail.getLineCount({ sublistId: 'inventoryassignment' }) > 0) {
                const issueAssignmentText = invDetail.getSublistText({
                    sublistId: 'inventoryassignment',
                    fieldId: 'issueinventorynumber',
                    line: 0
                }) || invDetail.getSublistText({
                    sublistId: 'inventoryassignment',
                    fieldId: 'receiptinventorynumber',
                    line: 0
                });
                if (issueAssignmentText) return issueAssignmentText;
            }
        } catch (e) {
            log.debug('Serial Extractor Info', e.message);
        }
        return null;
    };

    /**
     * Creates a Field Service Asset record (customrecord_nx_asset).
     */
    const createFieldServiceAsset = (params) => {
        const assetRec = record.create({
            type: CONFIG.ASSET_RECORD_TYPE,
            isDynamic: true
        });

        // Set Name: e.g. "BOT ASM MYT-00067-00-00001 Robot_TO1024_L1"
        const assetName = `${params.itemText} ${params.serialNumber}`;
        assetRec.setValue({
            fieldId: CONFIG.FIELDS.ASSET_NAME,
            value: assetName
        });

        // Set Item Link
        if (params.itemId) {
            try {
                assetRec.setValue({
                    fieldId: CONFIG.FIELDS.ASSET_ITEM,
                    value: params.itemId
                });
            } catch (e) {
                log.debug('Set Asset Item Fallback', e.message);
            }
        }

        // Set Serial Number (custrecord_nx_asset_serial)
        assetRec.setValue({
            fieldId: CONFIG.FIELDS.ASSET_SERIAL,
            value: params.serialNumber
        });

        // Set Customer Link on Asset field 'custrecord_nx_asset_customer'
        if (params.customerId) {
            try {
                assetRec.setValue({
                    fieldId: CONFIG.FIELDS.ASSET_CUSTOMER,
                    value: params.customerId
                });
            } catch (e) {
                log.debug('Set Asset Customer Error', e.message);
            }
        }

        // Set Transfer Order Link on Asset (custrecord_nx_asset_transaction)
        if (params.toId) {
            try {
                assetRec.setValue({
                    fieldId: CONFIG.FIELDS.ASSET_TRANSACTION,
                    value: params.toId
                });
            } catch (e) {
                log.debug('Set Asset Transaction Fallback', e.message);
            }
        }

        // Map Transfer Order fields to Asset
        if (params.assetCustomFields) {
            Object.keys(params.assetCustomFields).forEach((assetField) => {
                const val = params.assetCustomFields[assetField];
                if (val !== null && val !== undefined && val !== '') {
                    try {
                        assetRec.setValue({
                            fieldId: assetField,
                            value: val
                        });
                    } catch (mapErr) {
                        log.debug(`Set Asset Custom Field Note (${assetField})`, mapErr.message);
                    }
                }
            });
        }

        const assetId = assetRec.save({
            enableSourcing: true,
            ignoreMandatoryFields: true
        });

        log.debug('Asset Created', `Asset Record ID: ${assetId} with Serial: ${params.serialNumber} linked to TO ID: ${params.toId}`);
        return assetId;
    };

    /**
     * Creates an FSM Task record using the specified Custom Form ID.
     */
    const createFSMTask = (params) => {
        const taskRec = record.create({
            type: record.Type.TASK,
            isDynamic: true
        });

        // Set Custom Form ID from parameter (custscript_task_form_id)
        taskRec.setValue({
            fieldId: 'customform',
            value: params.formId
        });

        const fallbackTo = params.tranId && params.tranId.toString().startsWith('TO') ? params.tranId : ('TO #' + params.tranId);
        taskRec.setValue({
            fieldId: CONFIG.FIELDS.TASK_TITLE,
            value: params.title || `Pick & Deliver: ${params.itemText} (${params.serialNumber}) - ${fallbackTo}`
        });

        // Set Customer on Task field 'custevent_nx_customer' and standard 'company' field
        if (params.customerId) {
            try {
                taskRec.setValue({
                    fieldId: CONFIG.FIELDS.TASK_CUSTOMER,
                    value: params.customerId
                });
            } catch (e) {
                log.debug('Task Customer Set Error (custevent_nx_customer)', e.message);
            }
            try {
                taskRec.setValue({
                    fieldId: CONFIG.FIELDS.TASK_COMPANY,
                    value: params.customerId
                });
            } catch (e2) {
                log.debug('Task Standard Company Set Note', e2.message);
            }
        }

        // Set Customer Address on Task field 'custevent_nx_address'
        if (params.customerAddress) {
            try {
                taskRec.setValue({
                    fieldId: CONFIG.FIELDS.TASK_ADDRESS,
                    value: params.customerAddress
                });
            } catch (e) {
                log.debug('Task Address Set Error', e.message);
            }
        }

        // Set Task Description / Message (Displays full breakdown inside FSM Mobile tab)
        const taskDetails = params.fullDescription || `TO: ${params.tranId} | Item: ${params.itemText}`;
        try {
            taskRec.setValue({
                fieldId: CONFIG.FIELDS.TASK_MESSAGE,
                value: taskDetails
            });
        } catch (e) {
            log.debug('Task Message Set Note', e.message);
        }

        // Set Link to Originating Transfer Order (standard transaction and NextService custevent_nx_created_from)
        try {
            taskRec.setValue({
                fieldId: CONFIG.FIELDS.TASK_TRANSACTION,
                value: params.toId
            });
        } catch (e) {
            log.debug('Task Standard Transaction Set Error', e.message);
        }
        try {
            taskRec.setValue({
                fieldId: CONFIG.FIELDS.TASK_CREATED_FROM,
                value: params.toId
            });
        } catch (e2) {
            log.debug('Task custevent_nx_created_from Set Note', e2.message);
        }

        // Set Link to Created Asset (custevent_nx_task_asset)
        try {
            taskRec.setValue({
                fieldId: CONFIG.FIELDS.TASK_ASSET,
                value: params.assetId
            });
        } catch (e) {
            log.debug('Task Asset field set error (custevent_nx_task_asset)', e.message);
        }

        // Set Task Type from line item (custevent_nx_task_type)
        try {
            taskRec.setValue({
                fieldId: CONFIG.FIELDS.TASK_TYPE,
                value: params.taskType
            });
        } catch (e) {
            log.debug('Task Type field set error (custevent_nx_task_type)', e.message);
        }

        // Set Assigned To Employee if valid
        if (params.employeeId) {
            try {
                taskRec.setValue({
                    fieldId: CONFIG.FIELDS.TASK_ASSIGNED,
                    value: params.employeeId
                });
            } catch (e) {
                log.debug('Task Assigned Employee Set Error', e.message);
            }
        }

        const taskId = taskRec.save({
            enableSourcing: true,
            ignoreMandatoryFields: true
        });

        // Ensure Transfer Order link is committed directly to database (bypassing any custom form restrictions)
        try {
            record.submitFields({
                type: record.Type.TASK,
                id: taskId,
                values: {
                    transaction: params.toId,
                    custevent_nx_created_from: params.toId
                },
                options: { ignoreMandatoryFields: true }
            });
        } catch (subErr) {
            try {
                record.submitFields({
                    type: record.Type.TASK,
                    id: taskId,
                    values: {
                        transaction: params.toId
                    },
                    options: { ignoreMandatoryFields: true }
                });
            } catch (subErr2) {
                log.debug('Direct submitFields transaction fallback note', subErr2.message);
            }
        }

        log.debug('Task Created', `Task Record ID: ${taskId} created with Form ${params.formId} linked to Asset ID: ${params.assetId} for TO: ${params.toId}`);
        return taskId;
    };

    return {
        afterSubmit
    };
});
