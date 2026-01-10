import * as fs from 'fs';
import * as path from 'path';
import { 
  WorkOrderDocument, 
  WorkCenterDocument, 
  ManufacturingOrderDocument,
  ReflowResult 
} from '../src/reflow/types';
import { ConstraintChecker } from '../src/reflow/constraint-checker';

export interface TestInput {
  workOrders: WorkOrderDocument[];
  workCenters: WorkCenterDocument[];
  manufacturingOrders: ManufacturingOrderDocument[];
}

export interface TestExample {
  input: TestInput;
}

export interface TestCase {
  name: string;
  description: string;
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

/**
 * Validates that the reflow result satisfies all constraints.
 * Tests pass/fail based solely on whether all constraints are satisfied.
 */
export function validateConstraints(
  result: ReflowResult,
  input: TestInput
): { valid: boolean; errors: string[] } {
  const constraintChecker = new ConstraintChecker();

  // Validate all constraints (valid dates, due dates, overlaps, work center availability)
  return constraintChecker.validateAllConstraints(
    result.updatedWorkOrders,
    input.workCenters,
    input.manufacturingOrders
  );
}
