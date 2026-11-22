/** Mix one decoded frame into mono. `getSample(channel)` must return a finite or
 * non-finite numeric sample; non-finite values are treated as silence. */
export function mixChannelFrame(channelCount, getSample, mode='average') {
  if(!Number.isInteger(channelCount)||channelCount<1)throw new Error('At least one audio channel is required');
  if(mode==='left')return finite(getSample(0));
  if(mode==='right')return finite(getSample(channelCount>1?1:0));
  let sum=0;for(let c=0;c<channelCount;c++)sum+=finite(getSample(c));
  return sum/channelCount;
}
function finite(value){return Number.isFinite(value)?value:0;}
