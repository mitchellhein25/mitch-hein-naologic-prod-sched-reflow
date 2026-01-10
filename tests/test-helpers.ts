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
  expectedFailureReason?: string;
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
 * For impossible scenarios (where expectedFailureReason is provided), checks that
 * the reflow service correctly identified the schedule as impossible.
 * Tests pass/fail based solely on whether all constraints are satisfied (or correctly identified as impossible).
 */
export function validateConstraints(
  result: ReflowResult,
  input: TestInput,
  expectedFailureReason?: string
): { valid: boolean; errors: string[] } {
  const constraintChecker = new ConstraintChecker();

  // If this is an impossible scenario, check that the service correctly identified it
  if (expectedFailureReason !== undefined) {
    if (!result.impossible) {
      return {
        valid: false,
        errors: [
          `Expected schedule to be identified as impossible (${expectedFailureReason}), but reflow service returned impossible=false`
        ]
      };
    }
    // For impossible scenarios, we don't require constraints to be satisfied
    // but we verify that the service correctly detected impossibility
    return {
      valid: true,
      errors: []
    };
  }

  // For normal scenarios, validate all constraints are satisfied
  if (result.impossible) {
    return {
      valid: false,
      errors: [
        'Reflow service incorrectly identified schedule as impossible when it should be solvable'
      ]
    };
  }

  // Validate all constraints (valid dates, due dates, overlaps, work center availability)
  return constraintChecker.validateAllConstraints(
    result.updatedWorkOrders,
    input.workCenters,
    input.manufacturingOrders
  );
}
