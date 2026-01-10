export interface BaseDocument<TDocType extends string, TData> {
  docId: string;
  docType: TDocType;
  data: TData;
}

export interface WorkOrderData {
  workOrderNumber: string;
  manufacturingOrderId: string;
  workCenterId: string;
  
  startDate: string;
  endDate: string;
  durationMinutes: number;
  
  isMaintenance: boolean;
  
  dependsOnWorkOrderIds: string[];
}

export interface WorkCenterShift {
  dayOfWeek: number;
  startHour: number;
  endHour: number;
}

export interface MaintenanceWindow {
  startDate: string;
  endDate: string;
  reason?: string;
}

export interface WorkCenterData {
  name: string;
  
  shifts: WorkCenterShift[];
  
  maintenanceWindows: MaintenanceWindow[];
}

export interface ManufacturingOrderData {
  manufacturingOrderNumber: string;
  itemId: string;
  quantity: number;
  dueDate: string;
}

const WORK_ORDER_DOC_TYPE = "workOrder";
const WORK_CENTER_DOC_TYPE = "workCenter";
const MANUFACTURING_ORDER_DOC_TYPE = "manufacturingOrder";

export type WorkOrderDocument = BaseDocument<typeof WORK_ORDER_DOC_TYPE, WorkOrderData>;
export type WorkCenterDocument = BaseDocument<typeof WORK_CENTER_DOC_TYPE, WorkCenterData>;
export type ManufacturingOrderDocument = BaseDocument<typeof MANUFACTURING_ORDER_DOC_TYPE, ManufacturingOrderData>;

export type Document = WorkOrderDocument | WorkCenterDocument | ManufacturingOrderDocument;

export function isWorkOrder(doc: Document): doc is WorkOrderDocument {
  return doc.docType === WORK_ORDER_DOC_TYPE;
}

export function isWorkCenter(doc: Document): doc is WorkCenterDocument {
  return doc.docType === WORK_CENTER_DOC_TYPE;
}

export function isManufacturingOrder(doc: Document): doc is ManufacturingOrderDocument {
  return doc.docType === MANUFACTURING_ORDER_DOC_TYPE;
}

export interface WorkOrderChange {
  workOrderId: string;
  oldStartDate: string;
  newStartDate: string;
  oldEndDate: string;
  newEndDate: string;
}

export interface ReflowResult {
  updatedWorkOrders: WorkOrderDocument[];
  changes: WorkOrderChange[];
  explanation: string;
}