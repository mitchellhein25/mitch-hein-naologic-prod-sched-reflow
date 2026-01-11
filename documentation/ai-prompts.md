# Key Design Decisions - Engineering Prompts

This document captures the critical architectural and design decisions that shaped the reflow planner implementation. Each entry demonstrates systematic engineering judgment, consideration of trade-offs, and application of software engineering best practices.

## Type System Architecture - Discriminated Union Pattern

**Prompt:**
> "What is the most type-safe and maintainable TypeScript architecture for representing multiple document types (WorkOrder, WorkCenter, ManufacturingOrder) that share a common structure but have distinct data schemas? The system needs to support type narrowing at compile-time and runtime type guards."

**Context:** Designing the foundational type system for a document-based scheduling system with polymorphic document types. Need to ensure type safety while maintaining extensibility for future document types.

**Decision:** Implemented a discriminated union pattern using a generic `BaseDocument<TDocType, TData>` type with concrete document variants. Each document type is created via type aliases combining the base with specific docType and data interfaces. Type guards (`isWorkOrder`, `isWorkCenter`, etc.) provide runtime type narrowing.

---

## Separation of Concerns - Constraint Validation Architecture

**Prompt:**
> "Constraint validation logic should be extracted into a dedicated business logic module."

**Context:** Initially, constraint validation logic was implemented directly in `test-helpers.ts`. This violated separation of concerns and created duplication risk, as the same validation logic would need to be used by both the reflow service implementation and test validation.

**Decision:** Extracted all constraint validation logic into a dedicated `ConstraintChecker` class in `src/reflow/constraint-checker.ts`. The class exposes individual validation methods for each constraint type, plus a composite `validateAllConstraints` method. Test helpers now delegate to this module rather than implementing validation themselves.

---

## Incremental Development Strategy - Test-Driven Architecture

**Prompt:**
> "Structure the test infrastructure to support incremental feature development, where complexity increases gradually. The system needs to support thousands of test cases while maintaining clear progression from basic scenarios to complex multi-constraint scenarios."

**Context:** Planning a test-driven development approach for a complex scheduling algorithm with multiple interacting constraints (basic scheduling, dependencies, work center conflicts, shift logic, maintenance windows). Need a scalable test structure that enables incremental implementation.

**Decision:** Organized test fixtures into feature-based directories (`basic_reflow/`, future: `dependencies/`, `work_center_conflicts/`, `shift_logic/`, `maintenance_windows/`). Each directory contains JSON fixture files with 10-20 test examples, allowing comprehensive coverage while maintaining clear feature boundaries. Tests are structured to progress from simple (single constraint) to complex (multiple constraints).

---

## Algorithm Selection - Systematic Trade-off Analysis

**Prompt:**
> "Explain the algorithmic approaches that could be used for basic reflow. What are the possible algorithms that could be used, and what are the trade-offs of the different implementations?"

**Context:** Before implementing the reflow service, needed to systematically evaluate algorithmic approaches to balance correctness, performance, complexity, and maintainability. The problem involves scheduling work orders with multiple interacting constraints (due dates, overlaps, work center availability) where different algorithms have different computational and implementation characteristics.

**Decision:** Conducted comprehensive analysis of 8 algorithmic approaches (Greedy Iterative Fix, Two-Phase Approach, Priority-Based Scheduling, CSP Solver, Interval Scheduling, Linear Programming, Backward Scheduling, Topological Sort). Documented time/space complexity, pros/cons, and suitability for MVP vs. production. Selected Two-Phase Approach for MVP as it balances simplicity (O(n log n) complexity) with correctness guarantees (finite termination in 2 phases) and extensibility (natural extension points for future constraints).

---

## Test Philosophy - Constraint Satisfaction over Implementation Details

**Prompt:**
> "For tests, we don't need the reflow to match the exact number of changes or to monitor what changes are made. We just need to ensure that the output is a valid flow if possible. So remove the additional checks on expected changes or number of changes. We just need valid outputs that fit all constraints."

**Context:** Initial test suite validated both constraint satisfaction AND specific change counts/patterns. This created brittle tests that failed when implementation improvements produced equally valid but different solutions. The core requirement is constraint satisfaction, not specific scheduling strategies.

**Decision:** Simplified test infrastructure to focus solely on constraint validation. Removed all checks for exact change counts (`minChanges`, `maxChanges`, `specificChanges`), removed metadata tags, and removed complexity/feature classifications from fixtures. Tests now validate: (1) All constraints are satisfied, (2) All input work orders are present in output. This makes tests more robust to implementation improvements while maintaining correctness guarantees.

---

## Dependencies Implementation - Phased Optimization Approach

**Prompt:**
> "Implement dependencies functionality. This includes the `dependsOnWorkOrderIds` property in `WorkOrderData`. First implement test cases in a new folder `__fixtures__\dependencies` that test this piece. Then implement the addition of constraint checks for dependencies. Finally, implement the logic to handle dependencies in the reflow service."

**Context:** The reflow service needed to handle work order dependencies where dependent work orders must start after their prerequisite work orders complete. This introduces a new constraint type that interacts with existing due date and overlap constraints. The challenge was implementing dependency resolution while maintaining the existing phased approach and handling cases where dependencies and due dates conflict.

**Decision:** Extended the existing three-phase algorithm to include dependency handling as Phase 2, with an additional optimization phase (Phase 2.5) to handle complex interactions between dependencies and due dates:

1. **Phase 1**: Resolve due date violations (existing)
2. **Phase 2**: Resolve dependencies - Move dependent work orders to start after all their dependencies end
3. **Phase 2.5**: Optimize dependencies for due dates - Move dependencies earlier when their dependents still violate due dates
4. **Phase 3**: Resolve overlaps per work center (existing)

The dependency resolution uses an iterative approach to handle dependency chains (A → B → C). The optimization phase identifies cases where moving a dependency earlier can help a dependent meet its due date, even if the dependency doesn't violate its own due date. This targeted optimization handles the complex interaction where dependencies prevent dependents from meeting due dates.

---

## Shift Logic Implementation - Work Pause and Resume Across Shift Boundaries

**Prompt:**
> "Implement shift logic for work centers. Work orders must pause when shifts end and resume in the next available shift. Work centers may have multiple shifts per day, and shifts may span midnight. The implementation must account for work pausing during non-working hours and correctly calculating end dates based on actual working time rather than continuous duration."

**Context:** Work centers operate on defined shift schedules where work can only occur during shift hours. Work orders that span multiple shifts must pause when a shift ends and resume when the next shift begins. This fundamentally changes how end dates are calculated - a work order with 120 minutes duration starting at 4 PM in a shift that ends at 5 PM must pause at 5 PM, resume at 8 AM the next day, and complete at 9 AM (not at 6 PM as continuous calculation would suggest). The system needed to handle multiple shifts per day, shifts spanning midnight (e.g., 22:00-06:00), and correctly integrate shift logic with existing constraints (due dates, dependencies, overlaps).

**Decision:** Implemented shift-aware scheduling in two phases:

1. **Constraint Validation**: Added `calculateEndDateWithShifts` helper method to the `ConstraintChecker` class that simulates work progression through shifts, accounting for pauses between shifts and resumption in the next available shift. This method handles multiple shifts per day and midnight-spanning shifts. The validation ensures work order end dates match the expected shift-adjusted calculation.

2. **Reflow Service Implementation**: 
   - Added Phase 0 (normalization) that recalculates all work order end dates to account for shifts before any constraint resolution begins
   - Updated all reflow phases (`resolveDueDateViolations`, `resolveDependencies`, `optimizeDependenciesForDueDates`, `resolveOverlaps`) to use shift-aware end date calculations
   - Reused the same `calculateEndDateWithShifts` algorithm from constraint checker to ensure consistency between validation and scheduling

The implementation uses a simulation-based approach that iterates through time, identifies active shifts, processes work during shift hours, and moves to the next available shift when current shifts end. This approach naturally handles all shift configurations (single shift per day, multiple shifts per day, midnight-spanning shifts) without special cases.

---

## Maintenance Windows Implementation - Hybrid Behavior Model

**Prompt:**
> "Implement maintenance windows functionality following a hybrid behavior model. Regular work orders (isMaintenance: false) should pause during maintenance windows and resume after, similar to how they handle shifts. Maintenance work orders (isMaintenance: true) should be fixed in place and cannot be rescheduled. Maintenance windows are fixed periods where no work can be completed and cannot be changed. The implementation must account for work pausing during maintenance periods and correctly calculating end dates based on actual working time, working together with shifts when both constraints exist."

**Context:** Work centers have scheduled maintenance windows where regular work cannot occur, but maintenance work orders themselves must remain fixed. This introduces a new constraint type that interacts with existing shift logic, dependencies, due dates, and overlap constraints. The system needed to handle maintenance windows working together with shifts (work pauses for both), distinguish between regular work orders (which pause) and maintenance work orders (which are fixed), and correctly integrate maintenance window logic with all existing constraint types.

**Decision:** Implemented maintenance window support using a hybrid behavior model across both the constraint checker and reflow service:

1. **Regular Work Orders (isMaintenance: false)**: Pause during maintenance windows and resume after, similar to shift behavior. Work pauses for both shift boundaries AND maintenance windows, with maintenance windows taking priority when determining pause periods.

2. **Maintenance Work Orders (isMaintenance: true)**: Fixed in place and cannot be rescheduled. These work orders are excluded from all rescheduling phases, treated as fixed blockers in overlap resolution, and skipped in impossibility checks.

3. **Combined Calculation**: Created `calculateEndDateWithShiftsAndMaintenanceWindows` method that handles both constraints together, checking for maintenance windows first (absolute dates), then shifts. This ensures work pauses for both constraint types correctly.

4. **Constraint Validation**: Updated constraint checker to use combined validation when both shifts and maintenance windows exist, with fallback to individual validation when only one exists. Maintenance work orders are skipped in both validation methods.

5. **Reflow Service Integration**: Updated all phases (normalization, due date resolution, dependency resolution, optimization, overlap resolution) to use the combined calculation method and skip maintenance work orders appropriately.

The implementation follows the same simulation-based approach as shifts, iterating through time and accounting for both maintenance windows and shift boundaries. This approach naturally handles all combinations (shifts only, maintenance windows only, both together) without special cases, ensuring consistency between validation and scheduling.