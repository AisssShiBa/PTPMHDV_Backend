package com.ptpmhdv.merchantservice.dto;

import com.ptpmhdv.merchantservice.model.Merchant;
import com.ptpmhdv.merchantservice.model.MerchantStatus;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class MerchantActiveResponse {
    private String id;
    private String ownerId;
    private String businessName;
    private MerchantStatus status;
    private boolean active;

    public static MerchantActiveResponse fromEntity(Merchant merchant) {
        return MerchantActiveResponse.builder()
                .id(merchant.getId())
                .ownerId(merchant.getOwnerId())
                .businessName(merchant.getBusinessName())
                .status(merchant.getStatus())
                .active(MerchantStatus.APPROVED.equals(merchant.getStatus()))
                .build();
    }
}
