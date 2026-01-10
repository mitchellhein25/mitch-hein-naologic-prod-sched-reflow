import * as path from 'path';
import { ReflowService } from '../src/reflow/reflow.service';
import {
  loadTestCases,
  validateConstraints,
  validateChanges,
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
        it(`${testCase.description || testCase.name} - Example ${example.metadata.tags.join(', ')}`, () => {
          const result = reflowService.reflow(
            example.input.workOrders,
            example.input.workCenters,
            example.input.manufacturingOrders
          );

          if (!example.metadata.shouldSucceed) {
            throw new Error('Test marked as shouldSucceed=false but not implemented yet');
          }

          const constraintValidation = validateConstraints(
            result,
            example.expectedConstraints,
            example.input
          );

          if (!constraintValidation.valid) {
            expect(constraintValidation.errors).toEqual([]);
            throw new Error(
              `Constraint validation failed for test "${testCase.name}":\n` +
              constraintValidation.errors.join('\n')
            );
          }

          const changeValidation = validateChanges(
            result,
            example.expectedChanges,
            example.input
          );

          if (!changeValidation.valid) {
            expect(changeValidation.errors).toEqual([]);
            throw new Error(
              `Change validation failed for test "${testCase.name}":\n` +
              changeValidation.errors.join('\n')
            );
          }

          expect(result.updatedWorkOrders.length).toBe(example.input.workOrders.length);
          
          const resultWorkOrderIds = new Set(result.updatedWorkOrders.map(wo => wo.docId));
          const inputWorkOrderIds = new Set(example.input.workOrders.map(wo => wo.docId));
          expect(resultWorkOrderIds).toEqual(inputWorkOrderIds);
        });
      }
    );
  });
});
