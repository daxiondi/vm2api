import { useEffect, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Outlet, useNavigate } from '@tanstack/react-router'
import { isAdminBillingPaused } from '@/lib/admin-billing-state'
import { getCookie } from '@/lib/cookies'
import { cn } from '@/lib/utils'
import { LayoutProvider } from '@/context/layout-provider'
import { SearchProvider } from '@/context/search-provider'
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar'
import { AppHeader } from '@/components/layout/app-header'
import { AppSidebar } from '@/components/layout/app-sidebar'
import { StarHint } from '@/components/layout/star-hint'
import { SkipToMain } from '@/components/skip-to-main'
import { onboardingQueryOptions } from '@/features/welcome/queries'

type AuthenticatedLayoutProps = {
  children?: ReactNode
  headerActions?: ReactNode
}

export function AuthenticatedLayout({
  children,
  headerActions,
}: AuthenticatedLayoutProps) {
  const defaultOpen = getCookie('sidebar_state') !== 'false'
  return (
    <SearchProvider>
      <LayoutProvider>
        <SidebarProvider defaultOpen={defaultOpen}>
          <SkipToMain />
          <AppSidebar />
          <SidebarInset
            className={cn(
              // Set content container, so we can use container queries
              '@container/content',

              // If layout is fixed, set the height
              // to 100svh to prevent overflow
              'has-data-[layout=fixed]:h-svh',

              // If layout is fixed and sidebar is inset,
              // set the height to 100svh - spacing (total margins) to prevent overflow
              'peer-data-[variant=inset]:has-data-[layout=fixed]:h-[calc(100svh-(var(--spacing)*4))]'
            )}
          >
            <AppHeader actions={headerActions} />
            {isAdminBillingPaused() ? (
              <div
                role='status'
                className='mx-4 mt-4 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-950 md:mx-6 dark:text-amber-100'
              >
                账单统计已临时暂停；业务调用和用量记录继续保留。
              </div>
            ) : null}
            <GuideGate />
            {children ?? <Outlet />}
          </SidebarInset>
          <StarHint />
        </SidebarProvider>
      </LayoutProvider>
    </SearchProvider>
  )
}

function GuideGate() {
  const navigate = useNavigate()
  const onboarding = useQuery(onboardingQueryOptions())
  const unused = onboarding.data?.guide_used === false
  useEffect(() => {
    if (!unused) return
    void navigate({ to: '/welcome', search: { setup: true }, replace: true })
  }, [unused, navigate])
  return null
}
