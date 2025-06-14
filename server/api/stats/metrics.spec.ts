// server/api/stats/metrics.spec.ts
// Change imports
import { describe, it, expect, mock, beforeEach, afterEach, spyOn, jest } from 'bun:test'; // Using jest for global access if needed, mock for functions
import eventHandler from './metrics.get';

// Module mocks with bun:test
// Note: bun:test mock.module needs a factory function that returns the mock.
mock.module('h3', () => ({
  getValidatedQuery: mock(), // mock function for getValidatedQuery
  eventHandler: mock((handler) => handler), // Pass through
}));

mock.module('@@/server/utils/query-filter', () => ({
    query2filter: mock().mockReturnValue([]),
    appendTimeFilter: mock(),
}));

const mockSqlToString = mock().mockReturnValue('SELECT MOCKED_SQL_QUERY');
mock.module('sql-bricks', () => ({
    select: (...args: any[]) => ({
        from: (...args: any[]) => ({
            where: (...args: any[]) => ({
                groupBy: (...args: any[]) => ({
                    orderBy: (...args: any[]) => ({
                        limit: (...args: any[]) => ({
                            toString: mockSqlToString,
                        })
                    })
                })
            })
        })
    })
}));

const mockUseWAE = mock();
// For globalThis.useWAE or #imports, mocking strategy might need care.
// If useWAE is expected to be a global or imported from a specific path:
// Option 1: If it's a global Bun might manage:
if (typeof globalThis.useWAE === 'function') { // Check if it was already a global
    spyOn(globalThis, 'useWAE' as any).mockImplementation(mockUseWAE);
} else { // Fallback if not, or handle via #imports mock
    globalThis.useWAE = mockUseWAE;
}

mock.module('#imports', () => ({
    useRuntimeConfig: mock().mockReturnValue({ dataset: 'test_dataset' }),
    useWAE: mockUseWAE,
}), { virtual: true });


describe('GET /api/stats/metrics (bun:test)', () => {
  let mockEvent: any;

  beforeEach(() => {
    // Reset mocks. Bun's `mock()` are auto-reset if `clearMocks` is true in bunfig or Jest config.
    // Explicitly clear calls if needed, or use mock.clearAllMocks() if that's the preferred Bun way.
    // For now, assume individual mock clearing or auto-reset.
    mockUseWAE.mockClear();
    mockSqlToString.mockClear().mockReturnValue('SELECT MOCKED_SQL_QUERY');

    // Clear mocks from h3 module
    const h3 = require('h3'); // require to get the mocked module
    h3.getValidatedQuery.mockClear();


    mockEvent = {
      node: {
        res: {
          setHeader: mock(), // Use mock() for setHeader
        },
      },
      query: { type: 'views', limit: 10 }
    };

    h3.getValidatedQuery.mockImplementation(async () => mockEvent.query);
  });

  afterEach(() => {
    // Bun's test runner automatically resets mocks between tests by default.
    // If specific cleanup is needed beyond that, do it here.
    // mock.clearAllMocks(); // Or use this if preferred
  });

  it('should return JSON data based on query parameters', async () => {
    const mockData = [{ name: 'pageA', count: 100 }, { name: 'pageB', count: 50 }];
    mockUseWAE.mockResolvedValue(mockData);

    const result = await eventHandler(mockEvent);

    const h3 = require('h3');
    expect(h3.getValidatedQuery).toHaveBeenCalledWith(mockEvent, expect.any(Function));
    expect(mockUseWAE).toHaveBeenCalledWith(mockEvent, 'SELECT MOCKED_SQL_QUERY');
    expect(result).toEqual(mockData);
    expect(mockEvent.node.res.setHeader).not.toHaveBeenCalled();
  });

  it('should return empty array if no data is available', async () => {
    mockUseWAE.mockResolvedValue([]);

    const result = await eventHandler(mockEvent);

    expect(mockUseWAE).toHaveBeenCalledWith(mockEvent, 'SELECT MOCKED_SQL_QUERY');
    expect(result).toEqual([]);
    expect(mockEvent.node.res.setHeader).not.toHaveBeenCalled();
  });
});
