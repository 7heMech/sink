// app/components/dashboard/analysis/Index.spec.ts
// Change imports
import { describe, it, expect, mock, spyOn, beforeEach, afterEach, beforeAll, afterAll } from 'bun:test';
import { shallowMount } from '@vue/test-utils'; // This remains as it's from Vue Test Utils
import Index from './Index.vue'; // Component under test
// toast is used from the mocked module, so direct import isn't needed here after mock.module
// import { toast } from 'vue-sonner';
// import * as csvUtils from '@/utils/csv'; // Not needed if we use mock.module for it

// Mock vue-sonner
mock.module('vue-sonner', () => ({
  toast: {
    success: mock(),
    error: mock(),
    info: mock(),
  },
}));

// Mock useAPI composable
const mockUseAPI = mock();
mock.module('@/utils/api', () => ({
  useAPI: mockUseAPI,
}));

// Mock the convertToCSV utility
const mockConvertToCSV = mock();
mock.module('@/utils/csv', () => ({
  convertToCSV: mockConvertToCSV,
}));

// Mock URL related functions (using global mock() for consistency if preferred, or keep as is if it works)
const mockCreateObjectURL = mock();
const mockRevokeObjectURL = mock();
if (!global.URL) {
    global.URL = { createObjectURL: mock(), revokeObjectURL: mock() } as any;
}
global.URL.createObjectURL = mockCreateObjectURL;
global.URL.revokeObjectURL = mockRevokeObjectURL;

const mockLink = { setAttribute: mock(), click: mock(), style: { visibility: '' } };
// Use spyOn from bun:test
spyOn(document, 'createElement').mockReturnValue(mockLink as any);
spyOn(document.body, 'appendChild').mockImplementation(() => {});
spyOn(document.body, 'removeChild').mockImplementation(() => {});

const componentsToStub = ['DashboardNav', 'DashboardDatePicker', 'DashboardFilters', 'DashboardAnalysisCounters', 'DashboardAnalysisViews', 'DashboardAnalysisMetrics'];
const stubs = {};
componentsToStub.forEach(comp => { stubs[comp] = { template: `<div class="stub-${comp.toLowerCase()}"><slot /></div>` }; });
stubs['Button'] = { template: '<button @click="$emit(\'click\')"><slot /></button>' };

const originalBlob = global.Blob;
beforeAll(() => {
  // Mock global.Blob using mock() from bun:test for consistency
  global.Blob = mock((content, options) => new originalBlob(content, options)) as any;
});
afterAll(() => { global.Blob = originalBlob; });

describe('DashboardAnalysisIndex.vue (bun:test with mocked util)', () => {
  let wrapper;
  const sampleJsonData = [ { name: 'Page A', views: 100 } ];
  const MOCKED_CSV_OUTPUT = 'mocked,csv,output\nvalue1,value2,value3';

  beforeEach(() => {
    // Bun's mocks are auto-reset by default. Explicitly clear if specific state needs to be managed.
    mockUseAPI.mockClear();
    mockConvertToCSV.mockClear();
    mockCreateObjectURL.mockClear();
    mockLink.setAttribute.mockClear();
    mockLink.click.mockClear();
    (document.createElement as any).mockClear(); // Clear spy calls
    (global.Blob as any).mockClear(); // Clear calls to the Blob mock

    // Clear toast mocks (assuming vue-sonner mock is set up correctly)
    const vueSonner = require('vue-sonner'); // Get mocked module
    vueSonner.toast.success.mockClear();
    vueSonner.toast.error.mockClear();
    vueSonner.toast.info.mockClear();


    mockCreateObjectURL.mockReturnValue('blob:fakedata');
    mockConvertToCSV.mockReturnValue(MOCKED_CSV_OUTPUT);

    wrapper = shallowMount(Index, { global: { stubs: stubs } });
    wrapper.vm.time = { startAt: 1672531200, endAt: 1673135999 };
    wrapper.vm.filters = { slug: 'test-slug' };
  });

  afterEach(() => {
    wrapper.unmount();
    // mock.clearAllMocks(); // Could be used here if auto-reset isn't sufficient or explicit global reset is desired
  });

  it('should call useAPI and the mocked convertToCSV, then trigger download', async () => {
    mockUseAPI.mockResolvedValue(sampleJsonData);

    const exportButton = wrapper.findAll('button').find(b => b.text().includes('Export CSV'));
    await exportButton.trigger('click');

    expect(mockUseAPI).toHaveBeenCalledWith('/api/stats/metrics', expect.objectContaining({
      query: expect.objectContaining({ type: 'views' })
    }));

    expect(mockConvertToCSV).toHaveBeenCalledWith(sampleJsonData);
    expect(global.Blob).toHaveBeenCalledWith([MOCKED_CSV_OUTPUT], { type: 'text/csv;charset=utf-8;' });

    const vueSonner = require('vue-sonner');
    expect(vueSonner.toast.success).toHaveBeenCalledWith('CSV export successful. Download has started.');
    expect(document.createElement).toHaveBeenCalledWith('a');
  });

  it('should call convertToCSV even if API returns empty array, and show info if result is empty', async () => {
    mockUseAPI.mockResolvedValue([]);
    mockConvertToCSV.mockReturnValue('');

    const exportButton = wrapper.findAll('button').find(b => b.text().includes('Export CSV'));
    await exportButton.trigger('click');

    expect(mockConvertToCSV).toHaveBeenCalledWith([]);
    const vueSonner = require('vue-sonner');
    expect(vueSonner.toast.info).toHaveBeenCalledWith('No data available to export after conversion.');
    expect(mockLink.click).not.toHaveBeenCalled();
  });

  it('should show info toast if API returns non-array data that results in no items for conversion', async () => {
    mockUseAPI.mockResolvedValue({ data: [] });
    mockConvertToCSV.mockReturnValue('');

    const exportButton = wrapper.findAll('button').find(b => b.text().includes('Export CSV'));
    await exportButton.trigger('click');

    expect(mockConvertToCSV).toHaveBeenCalledWith([]);
    const vueSonner = require('vue-sonner');
    expect(vueSonner.toast.info).toHaveBeenCalledWith('No data available to export after conversion.');
    expect(mockLink.click).not.toHaveBeenCalled();
  });

  it('should show error toast if useAPI call fails (and not call convertToCSV)', async () => {
    mockUseAPI.mockRejectedValue(new Error('API Error'));
    const exportButton = wrapper.findAll('button').find(b => b.text().includes('Export CSV'));
    await exportButton.trigger('click');

    expect(mockConvertToCSV).not.toHaveBeenCalled();
    const vueSonner = require('vue-sonner');
    expect(vueSonner.toast.error).toHaveBeenCalledWith('CSV export failed. Please try again.');
  });
});
