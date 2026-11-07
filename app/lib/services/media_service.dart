import '../core/api_client.dart';
import '../core/json_utils.dart';

/// 媒体上传：图片 / 语音 / 头像。返回 {id,url,mime,size,kind}。
class MediaService {
  MediaService(this.api);

  final ApiClient api;

  Future<Map<String, dynamic>> upload({
    required String filePath,
    required String kind,
    String? characterId,
  }) async {
    final dynamic r = await api.upload(
      '/media',
      filePath: filePath,
      field: 'file',
      contentType: _mime(filePath),
      fields: <String, String>{
        'kind': kind,
        if (characterId != null && characterId.isNotEmpty)
          'characterId': characterId,
      },
    );
    return asMap(r);
  }

  Future<Map<String, dynamic>> uploadBytes({
    required List<int> bytes,
    required String filename,
    required String kind,
    String? characterId,
  }) async {
    final dynamic r = await api.uploadBytes(
      '/media',
      bytes: bytes,
      filename: filename,
      field: 'file',
      contentType: _mime(filename),
      fields: <String, String>{
        'kind': kind,
        if (characterId != null && characterId.isNotEmpty)
          'characterId': characterId,
      },
    );
    return asMap(r);
  }

  Uri mediaUri(String id) => api.mediaUri(id);

  Map<String, String> get headers => api.mediaHeaders;
}


String? _mime(String path) {
  final String p = path.toLowerCase();
  if (p.endsWith('.png')) return 'image/png';
  if (p.endsWith('.webp')) return 'image/webp';
  if (p.endsWith('.gif')) return 'image/gif';
  if (p.endsWith('.jpg') || p.endsWith('.jpeg')) return 'image/jpeg';
  if (p.endsWith('.wav')) return 'audio/wav';
  if (p.endsWith('.m4a')) return 'audio/mp4';
  if (p.endsWith('.mp3')) return 'audio/mpeg';
  return null;
}
