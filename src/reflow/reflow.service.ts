import { ManufacturingOrderDocument, ReflowResult, WorkCenterDocument, WorkOrderDocument } from "./types";

export class ReflowService {
  public reflow(
    workOrder: WorkOrderDocument[], 
    workCenter: WorkCenterDocument[],
    manufacturingOrder: ManufacturingOrderDocument[],
  ) : ReflowResult {
    
    // TODO : Implement reflow logic

    return {
      updatedWorkOrders: [],
      changes: [],
      explanation: "",
    };
  }
}