# TDD Test Patterns

Contract-focused and example-driven test patterns.

## Contract-Focused Testing

Test the interface/API contract, not implementation details.

### Good: Tests the contract
```typescript
describe('UserService', () => {
  it('returns user when found', async () => {
    const user = await userService.getById('123');
    expect(user).toHaveProperty('id', '123');
    expect(user).toHaveProperty('email');
  });

  it('throws NotFoundError when user does not exist', async () => {
    await expect(userService.getById('nonexistent'))
      .rejects.toThrow(NotFoundError);
  });
});
```

### Bad: Tests implementation details
```typescript
// Avoid: testing internal method calls
it('calls database.query with correct SQL', () => {
  userService.getById('123');
  expect(database.query).toHaveBeenCalledWith('SELECT * FROM users WHERE id = ?');
});
```

## Example-Driven Testing

Use concrete inputs and expected outputs.

### Pattern: Input -> Expected Output
```python
def test_calculate_discount():
    # 10% discount for orders over $100
    assert calculate_discount(150.00) == 15.00
    assert calculate_discount(100.00) == 10.00
    assert calculate_discount(50.00) == 0.00

def test_calculate_discount_edge_cases():
    assert calculate_discount(0) == 0.00
    assert calculate_discount(100.01) == 10.001  # Just over threshold
```

### Pattern: Table-Driven Tests
```go
func TestParseDate(t *testing.T) {
    tests := []struct {
        name    string
        input   string
        want    time.Time
        wantErr bool
    }{
        {"ISO format", "2024-01-15", time.Date(2024, 1, 15, 0, 0, 0, 0, time.UTC), false},
        {"US format", "01/15/2024", time.Date(2024, 1, 15, 0, 0, 0, 0, time.UTC), false},
        {"invalid", "not-a-date", time.Time{}, true},
    }

    for _, tt := range tests {
        t.Run(tt.name, func(t *testing.T) {
            got, err := ParseDate(tt.input)
            if (err != nil) != tt.wantErr {
                t.Errorf("ParseDate() error = %v, wantErr %v", err, tt.wantErr)
            }
            if !got.Equal(tt.want) {
                t.Errorf("ParseDate() = %v, want %v", got, tt.want)
            }
        })
    }
}
```

## Unit vs Integration Tests

### Unit Test
- Tests a single function/method in isolation
- Mocks external dependencies
- Fast execution

```typescript
// Unit test with mocked dependency
describe('OrderService.calculateTotal', () => {
  it('applies tax rate to subtotal', () => {
    const mockTaxService = { getRate: () => 0.08 };
    const service = new OrderService(mockTaxService);

    expect(service.calculateTotal(100)).toBe(108);
  });
});
```

### Integration Test
- Tests multiple components working together
- Uses real dependencies (database, API)
- Slower but catches integration issues

```typescript
// Integration test with real database
describe('OrderService integration', () => {
  beforeEach(async () => {
    await db.seed();
  });

  it('creates order and updates inventory', async () => {
    const order = await orderService.create({
      productId: 'prod-1',
      quantity: 2
    });

    expect(order.id).toBeDefined();
    const inventory = await inventoryService.getStock('prod-1');
    expect(inventory.quantity).toBe(8); // Was 10, now 8
  });
});
```

## Edge Cases to Consider

Always test these scenarios:

- **Empty/null inputs**: `null`, `undefined`, `""`, `[]`, `{}`
- **Boundary values**: 0, -1, MAX_INT, empty string
- **Error conditions**: Invalid input, network failure, timeout
- **Concurrency**: Race conditions, duplicate requests
- **State transitions**: Before/after, valid/invalid state changes

## Test Naming Conventions

Match the project's existing conventions. Common patterns:

| Pattern | Example |
|---------|---------|
| should_X_when_Y | `should_return_error_when_input_invalid` |
| given_when_then | `given_invalid_input_when_called_then_throws` |
| descriptive | `returns error for invalid input` |
| method_scenario_expected | `getUser_notFound_throwsError` |

## Red-Green-Refactor Checklist

1. **Red**: Write test that fails
   - [ ] Test compiles/runs
   - [ ] Test fails for the right reason
   - [ ] Failure message is clear

2. **Green**: Make test pass
   - [ ] Write minimal code to pass
   - [ ] No extra features
   - [ ] All tests pass

3. **Refactor**: Improve code
   - [ ] Remove duplication
   - [ ] Improve naming
   - [ ] All tests still pass
