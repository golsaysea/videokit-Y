"""JSON stdin/stdout bridge for VideoKit's optional Edge online speech backend."""
import asyncio
import json
import os
import sys
from pathlib import Path
import edge_tts

async def main(data):
    if data.get('action') == 'voices':
        voices = await edge_tts.list_voices()
        return {'voices': [{'voice_id': 'edge:' + v['ShortName'],
                            'name': v.get('FriendlyName') or v['ShortName'],
                            'locale': v.get('Locale', ''), 'gender': v.get('Gender', ''),
                            'category': v.get('Locale', '') + ' · ' + v.get('Gender', '')}
                           for v in voices]}
    if data.get('action') != 'synthesize':
        raise ValueError('Unknown Edge speech action')
    text = str(data.get('text', '')).strip()
    if not text:
        raise ValueError('配音文案不能为空')
    voice = str(data.get('voice', ''))
    output = Path(data['output'])
    temporary = output.with_suffix('.partial.mp3')
    subtitles = edge_tts.SubMaker()
    try:
        output.parent.mkdir(parents=True, exist_ok=True)
        communicate = edge_tts.Communicate(text, voice, rate=data.get('rate', '+0%'),
                                          pitch=data.get('pitch', '+0Hz'),
                                          boundary='SentenceBoundary')
        with temporary.open('wb') as media:
            async for chunk in communicate.stream():
                if chunk['type'] == 'audio':
                    media.write(chunk['data'])
                elif chunk['type'] == 'SentenceBoundary':
                    subtitles.feed(chunk)
        if temporary.stat().st_size == 0:
            raise RuntimeError('微软服务未返回音频，请稍后重试')
        os.replace(temporary, output)
        return {'srt': subtitles.get_srt(), 'output': str(output)}
    finally:
        if temporary.exists():
            temporary.unlink()

if __name__ == '__main__':
    sys.stdin.reconfigure(encoding='utf-8')
    sys.stdout.reconfigure(encoding='utf-8')
    try:
        result = asyncio.run(main(json.load(sys.stdin)))
        print(json.dumps(result, ensure_ascii=False))
    except Exception as error:
        print(json.dumps({'error': str(error)}, ensure_ascii=False))
        sys.exit(1)
