import { useGetAdminStats } from "@workspace/api-client-react";
import { BarChart3, Users, BookOpen } from "lucide-react";
import { motion } from "framer-motion";

export default function Admin() {
  const { data: stats, isLoading } = useGetAdminStats();

  return (
    <div className="w-full max-w-5xl mx-auto pt-4 pb-20">
      <div className="mb-10">
        <h1 className="text-3xl font-display font-bold text-foreground flex items-center gap-3">
          <BarChart3 className="w-8 h-8 text-primary" />
          Platform Analytics
        </h1>
        <p className="text-muted-foreground mt-2">Monitor student engagement and content consumption across the platform.</p>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-6 mb-10">
        <div className="bg-card rounded-2xl p-6 border border-border shadow-sm flex items-center gap-5">
          <div className="w-14 h-14 rounded-xl bg-blue-500/10 flex items-center justify-center text-blue-600">
            <BookOpen className="w-7 h-7" />
          </div>
          <div>
            <p className="text-sm font-semibold text-muted-foreground">Total Subtopics</p>
            <p className="text-3xl font-display font-bold text-foreground">{stats?.length || 0}</p>
          </div>
        </div>
        <div className="bg-card rounded-2xl p-6 border border-border shadow-sm flex items-center gap-5">
          <div className="w-14 h-14 rounded-xl bg-green-500/10 flex items-center justify-center text-green-600">
            <Users className="w-7 h-7" />
          </div>
          <div>
            <p className="text-sm font-semibold text-muted-foreground">Total Interactions</p>
            <p className="text-3xl font-display font-bold text-foreground">
              {stats?.reduce((acc, curr) => acc + curr.eventCount, 0) || 0}
            </p>
          </div>
        </div>
      </div>

      {/* Data Table */}
      <div className="bg-card rounded-3xl border border-border shadow-lg shadow-black/5 overflow-hidden">
        <div className="px-6 py-5 border-b border-border bg-secondary/30">
          <h2 className="text-lg font-semibold text-foreground">Content Engagement</h2>
        </div>
        
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-border text-xs uppercase tracking-wider text-muted-foreground">
                <th className="px-6 py-4 font-semibold">Subtopic Title</th>
                <th className="px-6 py-4 font-semibold text-right">Views / Completions</th>
                <th className="px-6 py-4 font-semibold text-right">Engagement Level</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/50 text-sm">
              {isLoading ? (
                Array.from({ length: 5 }).map((_, i) => (
                  <tr key={i}>
                    <td className="px-6 py-4"><div className="h-5 bg-muted animate-pulse rounded w-3/4"></div></td>
                    <td className="px-6 py-4"><div className="h-5 bg-muted animate-pulse rounded w-1/4 ml-auto"></div></td>
                    <td className="px-6 py-4"><div className="h-5 bg-muted animate-pulse rounded w-1/2 ml-auto"></div></td>
                  </tr>
                ))
              ) : stats?.length === 0 ? (
                <tr>
                  <td colSpan={3} className="px-6 py-12 text-center text-muted-foreground">
                    No analytics data available yet.
                  </td>
                </tr>
              ) : (
                stats?.sort((a, b) => b.eventCount - a.eventCount).map((stat, i) => {
                  const maxCount = Math.max(...stats.map(s => s.eventCount));
                  const percentage = maxCount > 0 ? (stat.eventCount / maxCount) * 100 : 0;
                  
                  return (
                    <motion.tr 
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: i * 0.05 }}
                      key={stat.subtopicId} 
                      className="hover:bg-muted/50 transition-colors"
                    >
                      <td className="px-6 py-4 font-medium text-foreground">{stat.subtopicTitle}</td>
                      <td className="px-6 py-4 text-right font-display font-bold text-foreground">
                        {stat.eventCount.toLocaleString()}
                      </td>
                      <td className="px-6 py-4">
                        <div className="flex items-center justify-end gap-3">
                          <span className="text-xs font-medium text-muted-foreground w-8 text-right">{Math.round(percentage)}%</span>
                          <div className="w-32 h-2 rounded-full bg-secondary overflow-hidden">
                            <div 
                              className="h-full bg-primary rounded-full" 
                              style={{ width: `${percentage}%` }} 
                            />
                          </div>
                        </div>
                      </td>
                    </motion.tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
