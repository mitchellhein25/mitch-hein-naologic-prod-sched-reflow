import * as path from 'path';
import { ReflowService } from '../src/reflow/reflow.service';
import {
  loadTestCases,
  validateConstraints,
  TestCase
} from './test-helpers';

function createTestSuite(suiteName: string, fixturesDirectory: string) {
  describe(suiteName, () => {
    const reflowService = new ReflowService();
    const fixturesDir = path.join(__dirname, '__fixtures__', fixturesDirectory);
    const testCases = loadTestCases(fixturesDir);

    if (testCases.length === 0) {
      test('Should have test cases loaded', () => {
        throw new Error('No test cases found in ' + fixturesDir);
      });
      return;
    }

    describe.each(testCases)('Test: $name', (testCase: TestCase) => {
      describe.each(testCase.testExamples.map((example, index) => ({ example, index })))(
        'Example $index',
        ({ example }) => {
          it(`${testCase.description || testCase.name}`, () => {
            const result = reflowService.reflow(
              example.input.workOrders,
              example.input.workCenters,
              example.input.manufacturingOrders
            );

            // Validate constraints or impossible status based on test type
            const constraintValidation = validateConstraints(
              result, 
              example.input, 
              example.expectedFailureReason
            );

            if (!constraintValidation.valid) {
              throw new Error(
                `Constraint validation failed for test "${testCase.name}":\n` +
                constraintValidation.errors.join('\n')
              );
            }

            // Ensure all input work orders are present in the output (by docId)
            expect(result.updatedWorkOrders.length).toBe(example.input.workOrders.length);
            
            const resultWorkOrderIds = new Set(result.updatedWorkOrders.map(wo => wo.docId));
            const inputWorkOrderIds = new Set(example.input.workOrders.map(wo => wo.docId));
            expect(resultWorkOrderIds).toEqual(inputWorkOrderIds);

            // For impossible scenarios, verify that impossible flag is set
            if (example.expectedFailureReason) {
              expect(result.impossible).toBe(true);
              expect(result.explanation).toContain('impossible');
            } else {
              // For solvable scenarios, verify that impossible flag is false
              expect(result.impossible).toBe(false);
            }
          });
        }
      );
    });
  });
}

createTestSuite('ReflowService - Basic Reflow Tests', 'basic_reflow');
createTestSuite('ReflowService - Dependencies Tests', 'dependencies');
createTestSuite('ReflowService - Shift Logic Tests', 'shifts');
