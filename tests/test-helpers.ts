import * as fs from 'fs';
import * as path from 'path';
import { 
  WorkOrderDocument, 
  WorkCenterDocument, 
  ManufacturingOrderDocument,
  ReflowResult 
} from '../src/reflow/types';
import { ConstraintChecker } from '../src/reflow/constraint-checker';
import { parseDate, isEqual } from '../src/utils/date-utils';

export interface ExpectedConstraints {
  allWorkOrdersMustHaveValidDates: boolean;
  allWorkOrdersMustCompleteBeforeDueDate: boolean;
  noWorkOrderOverlaps: boolean;
  workCenterAvailability: boolean;
  dependenciesRespected: boolean;
  shiftsRespected: boolean;
  maintenanceWindowsRespected: boolean;
}

export interface ExpectedChange {
  workOrderId: string;
  dateChanged: boolean;
}

export interface ExpectedChanges {
  minChanges: number;
  maxChanges: number;
  specificChanges?: ExpectedChange[];
}

export interface TestMetadata {
  tags: string[];
  shouldSucceed: boolean;
}

export interface TestInput {
  workOrders: WorkOrderDocument[];
  workCenters: WorkCenterDocument[];
  manufacturingOrders: ManufacturingOrderDocument[];
}

export interface TestExample {
  input: TestInput;
  expectedConstraints: ExpectedConstraints;
  expectedChanges: ExpectedChanges;
  metadata: TestMetadata;
}

export interface TestCase {
  name: string;
  description: string;
  complexity: string;
  feature: string;
  testExamples: TestExample[];
}

export function parseTestFile(filePath: string): TestCase {
  const fileContent = fs.readFileSync(filePath, 'utf-8');
  return JSON.parse(fileContent) as TestCase;
}

export function loadTestCases(directory: string): TestCase[] {
  const testCases: TestCase[] = [];
  
  if (!fs.existsSync(directory)) {
    return testCases;
  }

  const files = fs.readdirSync(directory);
  
  for (const file of files) {
    if (file.endsWith('.json')) {
      const filePath = path.join(directory, file);
      try {
        const testCase = parseTestFile(filePath);
        testCases.push(testCase);
      } catch (error) {
        console.error(`Error loading test case ${filePath}:`, error);
      }
    }
  }
  
  return testCases;
}

export function validateConstraints(
  result: ReflowResult,
  expected: ExpectedConstraints,
  input: TestInput
): { valid: boolean; errors: string[] } {
  const constraintChecker = new ConstraintChecker();

  return constraintChecker.validateAllConstraints(
    result.updatedWorkOrders,
    input.workCenters,
    input.manufacturingOrders
  );
}

export function validateChanges(
  result: ReflowResult,
  expected: ExpectedChanges,
  input: TestInput
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  const changeCount = result.changes.length;
  
  if (changeCount < expected.minChanges || changeCount > expected.maxChanges) {
    errors.push(
      `Expected ${expected.minChanges}-${expected.maxChanges} changes, but got ${changeCount}`
    );
  }

  if (expected.specificChanges) {
    const changesMap = new Map(
      result.changes.map(change => [change.workOrderId, change])
    );

    for (const expectedChange of expected.specificChanges) {
      const actualChange = changesMap.get(expectedChange.workOrderId);
      
      if (expectedChange.dateChanged && !actualChange) {
        errors.push(
          `Expected change for work order ${expectedChange.workOrderId}, but none found`
        );
      }

      if (expectedChange.dateChanged && actualChange) {
        const workOrder = input.workOrders.find(wo => wo.docId === actualChange.workOrderId);
        if (workOrder) {
          const oldStart = parseDate(actualChange.oldStartDate);
          const newStart = parseDate(actualChange.newStartDate);
          const oldEnd = parseDate(actualChange.oldEndDate);
          const newEnd = parseDate(actualChange.newEndDate);

          if (oldStart && newStart && oldEnd && newEnd) {
            if (isEqual(oldStart, newStart) && isEqual(oldEnd, newEnd)) {
              errors.push(
                `Work order ${expectedChange.workOrderId} marked as changed but dates are identical`
              );
            }
          }
        }
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors
  };
}
