import { ReflowService } from './src/reflow/reflow.service';
import {
  WorkOrderDocument,
  WorkCenterDocument,
  ManufacturingOrderDocument,
  ReflowResult
} from './src/reflow/types';

const workOrders: WorkOrderDocument[] = [
  {
    docId: 'wo-001',
    docType: 'workOrder',
    data: {
      workOrderNumber: 'WO-001',
      manufacturingOrderId: 'mo-001',
      workCenterId: 'wc-001',
      startDate: '2024-01-15T08:00:00Z',
      endDate: '2024-01-15T12:00:00Z',
      durationMinutes: 240,
      isMaintenance: false,
      dependsOnWorkOrderIds: []
    }
  },
  {
    docId: 'wo-002',
    docType: 'workOrder',
    data: {
      workOrderNumber: 'WO-002',
      manufacturingOrderId: 'mo-002',
      workCenterId: 'wc-001',
      startDate: '2024-01-15T10:00:00Z',
      endDate: '2024-01-15T14:00:00Z',
      durationMinutes: 240,
      isMaintenance: false,
      dependsOnWorkOrderIds: []
    }
  }
];

const workCenters: WorkCenterDocument[] = [
  {
    docId: 'wc-001',
    docType: 'workCenter',
    data: {
      name: 'Assembly Line A',
      shifts: [
        { dayOfWeek: 1, startHour: 8, endHour: 16 }
      ],
      maintenanceWindows: []
    }
  }
];

const manufacturingOrders: ManufacturingOrderDocument[] = [
  {
    docId: 'mo-001',
    docType: 'manufacturingOrder',
    data: {
      manufacturingOrderNumber: 'MO-001',
      itemId: 'item-123',
      quantity: 100,
      dueDate: '2024-01-20T17:00:00Z'
    }
  },
  {
    docId: 'mo-002',
    docType: 'manufacturingOrder',
    data: {
      manufacturingOrderNumber: 'MO-002',
      itemId: 'item-456',
      quantity: 200,
      dueDate: '2024-01-20T17:00:00Z'
    }
  }
];

const reflowService = new ReflowService();
const result: ReflowResult = reflowService.reflow(
  workOrders,
  workCenters,
  manufacturingOrders
);
console.log(JSON.stringify(result, null, 2));