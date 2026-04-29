import SegmentArrPage from "@/app/segment-arr/SegmentArrPage";

export default function SelfservePage() {
  return (
    <SegmentArrPage
      segment="selfserve"
      title="Self Serve"
      subtitle="Stripe self-serve ARR only (non sales-assist)."
    />
  );
}
