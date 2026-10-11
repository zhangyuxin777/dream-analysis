import { useEffect, useState } from 'react'
import type { Summary } from '@/types/summary'

export function useSummary() {
  const [data, setData] = useState<Summary | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetch('/data/summary.json')
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json()
      })
      .then(setData)
      .catch((e) => setError(String(e)))
  }, [])

  return { data, error }
}
