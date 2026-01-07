# Test Framework Detection

Detect the test framework by examining project files.

## JavaScript/TypeScript

| Indicator | Framework | Test Command |
|-----------|-----------|--------------|
| jest.config.js/ts/mjs | Jest | `npm test` or `npx jest` |
| vitest.config.js/ts | Vitest | `npm test` or `npx vitest` |
| .mocharc.* | Mocha | `npm test` or `npx mocha` |
| karma.conf.js | Karma | `npm test` |
| cypress.config.* | Cypress | `npx cypress run` |
| playwright.config.* | Playwright | `npx playwright test` |

Check package.json scripts.test for the actual command.

**Test file patterns:**
- `*.test.ts`, `*.test.js` - Common for Jest/Vitest
- `*.spec.ts`, `*.spec.js` - Common for all frameworks
- `__tests__/` directory - Jest convention

## Python

| Indicator | Framework | Test Command |
|-----------|-----------|--------------|
| pytest.ini | Pytest | `pytest` |
| conftest.py | Pytest | `pytest` |
| pyproject.toml [tool.pytest] | Pytest | `pytest` |
| setup.cfg [tool:pytest] | Pytest | `pytest` |
| tox.ini | Tox + Pytest | `tox` |
| unittest in imports | unittest | `python -m unittest` |

**Test file patterns:**
- `test_*.py` - Pytest convention
- `*_test.py` - Also valid for Pytest
- `tests/` directory

## Go

| Indicator | Framework | Test Command |
|-----------|-----------|--------------|
| *_test.go files | Go testing | `go test ./...` |
| go.mod | Go modules | `go test ./...` |

**Test file patterns:**
- `*_test.go` - Required suffix
- Test functions: `func TestXxx(t *testing.T)`

## Rust

| Indicator | Framework | Test Command |
|-----------|-----------|--------------|
| Cargo.toml | Cargo | `cargo test` |
| tests/ directory | Integration tests | `cargo test` |
| #[test] attribute | Unit tests | `cargo test` |

**Test patterns:**
- Unit tests: `#[cfg(test)]` module in source files
- Integration tests: `tests/` directory

## Java/Kotlin

| Indicator | Framework | Test Command |
|-----------|-----------|--------------|
| pom.xml + junit | JUnit (Maven) | `mvn test` |
| build.gradle + junit | JUnit (Gradle) | `gradle test` |
| testng.xml | TestNG | `mvn test` |

**Test file patterns:**
- `*Test.java`, `*Tests.java`
- `src/test/java/` directory

## C#/.NET

| Indicator | Framework | Test Command |
|-----------|-----------|--------------|
| *.csproj + xunit | xUnit | `dotnet test` |
| *.csproj + nunit | NUnit | `dotnet test` |
| *.csproj + mstest | MSTest | `dotnet test` |

**Test file patterns:**
- `*Tests.cs`, `*Test.cs`
- Separate test project convention

## Ruby

| Indicator | Framework | Test Command |
|-----------|-----------|--------------|
| spec/ directory | RSpec | `bundle exec rspec` |
| .rspec file | RSpec | `bundle exec rspec` |
| test/ directory | Minitest | `bundle exec rake test` |

## PHP

| Indicator | Framework | Test Command |
|-----------|-----------|--------------|
| phpunit.xml | PHPUnit | `./vendor/bin/phpunit` |
| tests/ directory | PHPUnit | `./vendor/bin/phpunit` |

## Detection Priority

1. Check for framework config files (most reliable)
2. Check package manager config (package.json, pyproject.toml, etc.)
3. Look for existing test files to determine patterns
4. Check for test directories (tests/, test/, spec/, __tests__/)
