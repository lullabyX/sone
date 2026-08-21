import PageContainer from "./PageContainer";

export default function FeedPage() {
  return (
    <div className="flex-1 bg-gradient-to-b from-th-surface to-th-base min-h-full">
      <PageContainer className="px-8 py-10">
        <h1 className="text-[32px] font-bold text-th-text-primary tracking-tight mb-10">
          Feed
        </h1>
      </PageContainer>
    </div>
  );
}
