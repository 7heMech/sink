<script setup>
import { now } from '@internationalized/date'
import { useUrlSearchParams } from '@vueuse/core'
import { safeDestr } from 'destr'
import { useAPI } from '@/utils/api';
import { toast } from 'vue-sonner';
import { convertToCSV } from '@/utils/csv'; // ADD THIS IMPORT

defineProps({
  link: {
    type: Object,
    default: () => null,
  },
})

async function exportCSV() {
  console.log('Exporting CSV (client-side conversion using util)...');
  try {
    const queryParams = {
      startAt: time.value.startAt,
      endAt: time.value.endAt,
      ...filters.value,
      // format: 'csv', // REMOVED
      type: 'views', // Still need type for the metrics endpoint
    };

    Object.keys(queryParams).forEach(key => queryParams[key] === undefined || queryParams[key] === null ? delete queryParams[key] : {});

    // Expect JSON response now
    const jsonData = await useAPI('/api/stats/metrics', {
      query: queryParams
      // Ensure parseResponse is not set to txt => txt, or remove it
    });

    if (!jsonData || (Array.isArray(jsonData) && jsonData.length === 0)) {
      console.error('No data returned for CSV export.');
      toast.info('No data available for export with the current filters.');
      return;
    }

    // Ensure jsonData is an array, as convertToCSV_client expects it
    const dataArray = Array.isArray(jsonData) ? jsonData : (jsonData.data && Array.isArray(jsonData.data) ? jsonData.data : []);
    if (dataArray.length === 0) {
         console.error('No data array found in response for CSV export.');
         toast.info('No data available for export with the current filters.');
         return;
    }

    // UPDATE THIS LINE: Call the imported convertToCSV function
    const csvData = convertToCSV(dataArray);

    if (!csvData.trim()) {
      console.error('CSV conversion resulted in empty string.');
      toast.info('No data available to export after conversion.');
      return;
    }

    const blob = new Blob([csvData], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    const url = URL.createObjectURL(blob);
    link.setAttribute('href', url);
    link.setAttribute('download', 'analysis-export.csv');
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);

    toast.success('CSV export successful. Download has started.');
    console.log('CSV Export successful (client-side using util).');

  } catch (error) {
    console.error('Error exporting CSV (client-side using util):', error);
    toast.error('CSV export failed. Please try again.');
  }
}

const searchParams = useUrlSearchParams('history')

const time = ref({
  startAt: date2unix(now().subtract({ days: 7 })),
  endAt: date2unix(now()),
})

provide('time', time)

function changeDate(dateRange) {
  console.log('changeDate', dateRange)
  // console.log('dashboard date', new Date(time[0] * 1000), new Date(time[1] * 1000))
  time.value.startAt = dateRange[0]
  time.value.endAt = dateRange[1]

  searchParams.time = JSON.stringify(time.value)
}

const filters = ref({})

provide('filters', filters)

function changeFilter(type, value) {
  console.log('changeFilter', type, value)
  filters.value[type] = value

  searchParams.filters = JSON.stringify(filters.value)
}

function restoreSearchParams() {
  try {
    if (searchParams.time) {
      time.value = safeDestr(searchParams.time)
    }
    if (searchParams.filters) {
      filters.value = safeDestr(searchParams.filters)
    }
  }
  catch (error) {
    console.error('restore searchParams error', error)
  }
}

onBeforeMount(() => {
  restoreSearchParams()
})
</script>

<template>
  <main class="space-y-6">
    <div class="flex flex-col gap-6 sm:gap-2 sm:flex-row sm:justify-between">
      <DashboardNav class="flex-1">
        <template
          v-if="link"
          #left
        >
          <h3 class="text-xl font-bold leading-10">
            {{ link.slug }} {{ $t('dashboard.stats') }}
          </h3>
        </template>
        <DashboardDatePicker @update:date-range="changeDate" />
      </DashboardNav>
      <DashboardFilters v-if="!link" @change="changeFilter" />
      <Button variant="outline" @click="exportCSV">
        Export CSV
      </Button>
    </div>
    <DashboardAnalysisCounters />
    <DashboardAnalysisViews />
    <DashboardAnalysisMetrics />
  </main>
</template>
