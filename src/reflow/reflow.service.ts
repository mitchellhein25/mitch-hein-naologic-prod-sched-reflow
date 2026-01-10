import { 
  ManufacturingOrderDocument, 
  ReflowResult, 
  WorkCenterDocument, 
  WorkOrderDocument,
  WorkOrderChange 
} from "./types";
import { parseDate, isAfter } from "../utils/date-utils";
import { DateTime } from "luxon";

export class ReflowService {
  public reflow(
    workOrders: WorkOrderDocument[], 
    workCenters: WorkCenterDocument[],
    manufacturingOrders: ManufacturingOrderDocument[],
  ): ReflowResult {
    // Create a deep copy of work orders to avoid mutating the input
    const updatedWorkOrders = workOrders.map(wo => ({
      ...wo,
      data: { ...wo.data }
    }));

    // Track original dates for change detection
    const originalDates = new Map<string, { startDate: string; endDate: string }>();
    updatedWorkOrders.forEach(wo => {
      originalDates.set(wo.docId, {
        startDate: wo.data.startDate,
        endDate: wo.data.endDate
      });
    });

    // Build manufacturing orders lookup map (exact match + prefix match support)
    const manufacturingOrdersMap = new Map<string, ManufacturingOrderDocument>();
    manufacturingOrders.forEach(mo => {
      manufacturingOrdersMap.set(mo.docId, mo);
    });

    // Phase 1: Resolve due date violations
    this.resolveDueDateViolations(updatedWorkOrders, manufacturingOrdersMap);

    // Phase 2: Resolve overlaps per work center
    this.resolveOverlaps(updatedWorkOrders);

    // Track changes
    const changes: WorkOrderChange[] = [];
    updatedWorkOrders.forEach(wo => {
      const original = originalDates.get(wo.docId);
      if (original && (original.startDate !== wo.data.startDate || original.endDate !== wo.data.endDate)) {
        changes.push({
          workOrderId: wo.docId,
          oldStartDate: original.startDate,
          newStartDate: wo.data.startDate,
          oldEndDate: original.endDate,
          newEndDate: wo.data.endDate
        });
      }
    });

    // Generate explanation
    const explanation = this.generateExplanation(changes.length, updatedWorkOrders.length);

    return {
      updatedWorkOrders,
      changes,
      explanation
    };
  }

  /**
   * Find manufacturing order for a work order using exact ID match.
   */
  private findManufacturingOrder(
    workOrder: WorkOrderDocument,
    manufacturingOrdersMap: Map<string, ManufacturingOrderDocument>
  ): ManufacturingOrderDocument | null {
    const manufacturingOrderId = workOrder.data.manufacturingOrderId;
    return manufacturingOrdersMap.get(manufacturingOrderId) || null;
  }

  /**
   * Phase 1: Resolve due date violations
   * Move work orders earlier so they complete before their manufacturing order's due date
   */
  private resolveDueDateViolations(
    workOrders: WorkOrderDocument[],
    manufacturingOrdersMap: Map<string, ManufacturingOrderDocument>
  ): void {
    for (const workOrder of workOrders) {
      const manufacturingOrder = this.findManufacturingOrder(workOrder, manufacturingOrdersMap);
      if (!manufacturingOrder) {
        continue; // Skip if manufacturing order not found
      }

      const dueDateStr = manufacturingOrder.data.dueDate;
      const dueDate = parseDate(dueDateStr);
      const endDate = parseDate(workOrder.data.endDate);
      const originalStartDate = parseDate(workOrder.data.startDate);

      if (!dueDate || !endDate || !originalStartDate) {
        continue; // Skip invalid dates
      }

      // Check if work order violates due date constraint
      if (isAfter(endDate, dueDate)) {
        // Calculate new end date (at or before due date)
        const maxEndDate = dueDate;
        
        // Calculate new start date based on duration
        const durationMinutes = workOrder.data.durationMinutes;
        const newStartDate = maxEndDate.minus({ minutes: durationMinutes });

        // Only move earlier if the new start is before original start
        // Never move later than original start date
        if (newStartDate < originalStartDate) {
          const newStartISO = newStartDate.toISO();
          const maxEndISO = maxEndDate.toISO();
          if (newStartISO && maxEndISO) {
            workOrder.data.startDate = newStartISO;
            workOrder.data.endDate = maxEndISO;
          }
        } else {
          // If we can't move earlier, keep original start and adjust end
          // This ensures the duration is preserved
          const newEndDate = originalStartDate.plus({ minutes: durationMinutes });
          const newEndISO = newEndDate.toISO();
          if (newEndISO) {
            workOrder.data.endDate = newEndISO;
          }
        }
      }
    }
  }

  /**
   * Phase 2: Resolve overlaps per work center
   * Pack work orders sequentially within each work center
   */
  private resolveOverlaps(workOrders: WorkOrderDocument[]): void {
    // Group work orders by work center
    const workOrdersByCenter = new Map<string, WorkOrderDocument[]>();
    for (const workOrder of workOrders) {
      const centerId = workOrder.data.workCenterId;
      if (!workOrdersByCenter.has(centerId)) {
        workOrdersByCenter.set(centerId, []);
      }
      workOrdersByCenter.get(centerId)!.push(workOrder);
    }

    // Resolve overlaps for each work center
    for (const centerWorkOrders of workOrdersByCenter.values()) {
      // Sort by start date (earliest first)
      centerWorkOrders.sort((a, b) => {
        const startA = parseDate(a.data.startDate);
        const startB = parseDate(b.data.startDate);
        if (!startA || !startB) return 0;
        return startA.toMillis() - startB.toMillis();
      });

      // Pack sequentially: next work order starts when previous ends
      let currentEnd: DateTime | null = null;
      for (const workOrder of centerWorkOrders) {
        const startDate = parseDate(workOrder.data.startDate);
        const endDate = parseDate(workOrder.data.endDate);
        const durationMinutes = workOrder.data.durationMinutes;

        if (!startDate || !endDate) {
          continue; // Skip invalid dates
        }

        if (currentEnd === null) {
          // First work order - keep its times, update currentEnd for next iteration
          currentEnd = endDate;
        } else {
          // Check for overlap
          if (startDate < currentEnd) {
            // Overlap detected - move this work order to start after previous ends
            const newStartISO = currentEnd.toISO();
            if (newStartISO) {
              workOrder.data.startDate = newStartISO;
            }
            currentEnd = currentEnd.plus({ minutes: durationMinutes });
            const endISO = currentEnd.toISO();
            if (endISO) {
              workOrder.data.endDate = endISO;
            }
          } else {
            // No overlap - keep original times, update currentEnd for next iteration
            currentEnd = endDate;
          }
        }
      }
    }
  }

  /**
   * Generate explanation string describing what was changed
   */
  private generateExplanation(changeCount: number, totalWorkOrders: number): string {
    if (changeCount === 0) {
      return "No changes needed. All work orders already satisfy constraints.";
    }

    return `Rescheduled ${changeCount} of ${totalWorkOrders} work orders to satisfy constraints.`;
  }
}