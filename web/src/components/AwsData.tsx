// The AWS part of the Data panel's Sources tab: the Amazon S3 browser and the RDS help card. DataPanel.tsx loads
// this file lazily (one mount point), so none of it is in the page's start bundle.

import { S3Section } from './S3Browser.tsx';
import { RdsHelp } from './RdsHelp.tsx';

export function AwsData({ home }: { home: string }) {
  return (
    <div className="space-y-5">
      <S3Section />
      <RdsHelp home={home} />
    </div>
  );
}
