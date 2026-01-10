import {
  WorkOrderDocument,
  WorkCenterDocument,
  ManufacturingOrderDocument
} from './types';
import {
  parseDate,
  isAfter,
  isSameOrBefore,
  rangesOverlap
} from '../utils/date-utils';

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export class ConstraintChecker {
  validateAllWorkOrdersHaveValidDates(
    workOrders: WorkOrderDocument[]
  ): ValidationResult {
    const errors: string[] = [];

    for (const workOrder of workOrders) {
      if (!workOrder.data.startDate || !workOrder.data.endDate) {
        errors.push(`Work order ${workOrder.docId} has invalid dates`);
        continue;
      }

      const startDate = parseDate(workOrder.data.startDate);
      const endDate = parseDate(workOrder.data.endDate);

      if (!startDate || !endDate) {
        errors.push(`Work order ${workOrder.docId} has invalid date format`);
        continue;
      }

      if (isSameOrBefore(endDate, startDate)) {
        errors.push(`Work order ${workOrder.docId} has startDate >= endDate`);
      }
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }

  validateAllWorkOrdersCompleteBeforeDueDate(
    workOrders: WorkOrderDocument[],
    manufacturingOrders: ManufacturingOrderDocument[]
  ): ValidationResult {
    const errors: string[] = [];

    const manufacturingOrdersMap = new Map(
      manufacturingOrders.map(mo => [mo.docId, mo.data.dueDate])
    );

    for (const workOrder of workOrders) {
      const dueDate = manufacturingOrdersMap.get(workOrder.data.manufacturingOrderId);
      if (!dueDate) {
        continue;
      }

      const endDate = parseDate(workOrder.data.endDate);
      const dueDateObj = parseDate(dueDate);

      if (!endDate || !dueDateObj) {
        errors.push(
          `Work order ${workOrder.docId} has invalid date format for due date validation`
        );
        continue;
      }

      if (isAfter(endDate, dueDateObj)) {
        errors.push(
          `Work order ${workOrder.docId} ends after due date (${workOrder.data.endDate} > ${dueDate})`
        );
      }
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }

  validateNoWorkOrderOverlaps(
    workOrders: WorkOrderDocument[]
  ): ValidationResult {
    const errors: string[] = [];

    const workOrdersByCenter = new Map<string, WorkOrderDocument[]>();

    for (const workOrder of workOrders) {
      const centerId = workOrder.data.workCenterId;
      if (!workOrdersByCenter.has(centerId)) {
        workOrdersByCenter.set(centerId, []);
      }
      workOrdersByCenter.get(centerId)!.push(workOrder);
    }
    // TODO : Implement more efficient algo
    for (const [centerId, centerWorkOrders] of workOrdersByCenter) {
      for (let i = 0; i < centerWorkOrders.length; i++) {
        for (let j = i + 1; j < centerWorkOrders.length; j++) {
          const wo1 = centerWorkOrders[i];
          const wo2 = centerWorkOrders[j];

          const wo1Start = parseDate(wo1.data.startDate);
          const wo1End = parseDate(wo1.data.endDate);
          const wo2Start = parseDate(wo2.data.startDate);
          const wo2End = parseDate(wo2.data.endDate);

          if (!wo1Start || !wo1End || !wo2Start || !wo2End) {
            errors.push(
              `Work orders ${wo1.docId} and ${wo2.docId} have invalid dates for overlap check on work center ${centerId}`
            );
            continue;
          }

          if (rangesOverlap(wo1Start, wo1End, wo2Start, wo2End)) {
            errors.push(
              `Work orders ${wo1.docId} and ${wo2.docId} overlap on work center ${centerId}`
            );
          }
        }
      }
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }

  validateWorkCenterAvailability(
    workOrders: WorkOrderDocument[],
    workCenters: WorkCenterDocument[]
  ): ValidationResult {
    const errors: string[] = [];

    const workCentersMap = new Map(
      workCenters.map(wc => [wc.docId, wc])
    );

    for (const workOrder of workOrders) {
      if (!workCentersMap.has(workOrder.data.workCenterId)) {
        errors.push(
          `Work order ${workOrder.docId} references non-existent work center ${workOrder.data.workCenterId}`
        );
      }
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }

  validateAllConstraints(
    workOrders: WorkOrderDocument[],
    workCenters: WorkCenterDocument[],
    manufacturingOrders: ManufacturingOrderDocument[]
  ): ValidationResult {
    const allErrors: string[] = [];

    const result1 = this.validateAllWorkOrdersHaveValidDates(workOrders);
    allErrors.push(...result1.errors);

    const result2 = this.validateAllWorkOrdersCompleteBeforeDueDate(
      workOrders,
      manufacturingOrders
    );
    allErrors.push(...result2.errors);

    const result3 = this.validateNoWorkOrderOverlaps(workOrders);
    allErrors.push(...result3.errors);

    const result4 = this.validateWorkCenterAvailability(workOrders, workCenters);
    allErrors.push(...result4.errors);

    return {
      valid: allErrors.length === 0,
      errors: allErrors
    };
  }
}
