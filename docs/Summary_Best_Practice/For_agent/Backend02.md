# B02 NestJS & Testability
scope: modules/controllers/providers; DTO validation; DI; unit testing

## structure
- modules by feature/domain (`users/`), not by layer (`services/`). enables lift-out to microservice later.
- flow: Controller -> Service -> Repository -> DB.
- controller = HTTP only: extract params, delegate, return. zero business logic, zero db access.
- service = business logic, stateless, throws HTTP exceptions.
- `exports` only what's needed; providers are module-scoped until exported.
- shared modules for cross-cutting: database, config, logging.
- scaffold with `nest g resource`.

## validation
- global ValidationPipe with `whitelist:true` (blocks mass assignment), `forbidNonWhitelisted:true` (400 instead of silent strip), `transform:true` (runtime type matches declared type).
- throw built-in exceptions (NotFoundException/ConflictException) from service, not `return null`.

## DI
- constructor injection only; class tokens by default (type-safe, refactor-safe).
- non-class tokens: use `Symbol` or exported const, never bare strings.
- `useFactory` + `inject` for async resources (db, redis) — connected before traffic.
- `useClass` to swap impl per env.
- stay on DEFAULT scope.

## scope warnings
- DEFAULT is singleton **per application/container**, NOT per module. two modules importing the same exported provider share one instance.
- REQUEST scope bubbles upward: any consumer of a REQUEST provider becomes REQUEST too => whole chain reinstantiated per request. use AsyncLocalStorage (`nestjs-cls`) for request context instead.
- mutable state in a singleton service leaks across requests/tenants.
- `interface` cannot be a DI token (erased at compile). use abstract class or token.
- circular deps => module boundary is wrong. `forwardRef()` treats the symptom.

## testing
- `Test.createTestingModule({providers:[Real,{provide:Dep,useValue:mock}]}).compile()`
- one unit per test, mock all deps, AAA pattern.
- test names describe behavior: `should throw NotFoundException when user not found`.
- controller tests assert only: right service method called, right params, right return. not HTTP mechanics, not validation, not business logic.
- type mocks as `jest.Mocked<Repository<T>>`, never `any` — `any` lets tests pass after signature drift.
- unit tests cannot validate SQL; pair with integration tests.

## perf
- framework overhead is rarely the bottleneck; fix DB (B03) and cache (B04) first.
- consider `@nestjs/platform-fastify` only for I/O-heavy high-RPS.
- avoid DB calls inside custom validators and heavy serialization in global interceptors.

## slide-errata
1. slides say provider is "Singleton — one instance per module". wrong: singleton per DI container/app.
2. mocks declared `let mockRepo: any` — loses type safety.
3. `private cache = new Map()` shown as acceptable singleton state — dangerous example; also won't sync across instances (B06), use Redis (B04).
4. `jest.spyOn` on the class under test tests the mock, not the code.
