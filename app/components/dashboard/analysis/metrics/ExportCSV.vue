<script setup>
import { Download } from 'lucide-vue-next'
import { useI18n } from 'vue-i18n'

const time = inject('time')
const { t } = useI18n()

async function exportToCSV() {
  // Fetch the metrics data with current time range
  const params = new URLSearchParams({
    startAt: time.value.startAt,
    endAt: time.value.endAt,
    type: 'slug',
    limit: 500,
  })

  try {
    const response = await useAPI(`/api/stats/metrics?${params}`)
    // Ensure response is an array before mapping
    const data = response?.data || []
    const csvContent = [
      ['name', 'count'],
      ...data.map(item => [item.name, item.count.toString()]),
    ].map(row => row.join(',')).join('\n')

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')

    link.setAttribute('href', url)
    link.setAttribute('download', `analytics-${time.value.startAt}-${time.value.endAt}.csv`)
    link.style.visibility = 'hidden'
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    URL.revokeObjectURL(url)
  }
  catch (error) {
    console.error('Export failed:', error)
  }
}
</script>

<template>
  <Button
    variant="outline"
    size="sm"
    @click="exportToCSV"
  >
    <Download class="w-4 h-4 mr-2" />
    {{ t('dashboard.export_csv') }}
  </Button>
</template>