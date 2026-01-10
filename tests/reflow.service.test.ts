import * as path from 'path';
import { ReflowService } from '../src/reflow/reflow.service';
import {
  loadTestCases,
  validateConstraints,
  TestCase
} from './test-helpers';

describe('ReflowService - Basic Reflow Tests', () => {
  const reflowService = new ReflowService();
  const basicReflowDir = path.join(__dirname, '__fixtures__', 'basic_reflow');
  const testCases = loadTestCases(basicReflowDir);

  if (testCases.length === 0) {
    test('Should have test cases loaded', () => {
      throw new Error('No test cases found in ' + basicReflowDir);
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

          // Validate that all constraints are satisfied
          const constraintValidation = validateConstraints(result, example.input);

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
        });
      }
    );
  });
});
